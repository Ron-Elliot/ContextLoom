# ContextLoom v1 Design Spec

**Status:** Draft  
**Relates to:** [ADR 0001](../adrs/0001-context-system-for-ai-workers.md)

---

## Overview

This document converts ADR 0001 from a proposed architecture into a concrete, buildable design. It resolves the eight open questions listed at the end of ADR 0001, documents the storage substrate selection, defines the MCP tool/resource split, and pins the project scoping semantics. It closes with the smallest end-to-end implementation loop that constitutes a working v1.

This is a design document, not implementation code.

---

## 1. Storage Substrate

**Decision: PostgreSQL with pgvector**

### Requirements recap

The system needs four storage capabilities:

1. Structured entity storage with relational querying
2. Graph relationship storage and traversal
3. Full-text lexical search
4. Vector/semantic search over embeddings

### Rationale

PostgreSQL satisfies all four needs in a single database:

- **Structured storage** — relational tables, JSONB for flexible claims, strong query planner
- **Graph traversal** — recursive CTEs (`WITH RECURSIVE`) handle the depth and fan-out expected at v1 scale; a dedicated graph database is not justified until traversal patterns outpace what Postgres can serve
- **Full-text search** — native `tsvector` / `tsquery` with GIN indexes
- **Semantic search** — `pgvector` extension for embedding storage and ANN queries

Alternative stores considered and rejected for v1:

| Option | Reason rejected |
|---|---|
| Neo4j + PostgreSQL | Doubles operational complexity; graph primitives not needed at v1 scale |
| Qdrant / Weaviate | Strong on vectors, weak on structured queries; no single-database solution |
| SQLite | Insufficient for concurrent ingestion; no vector extension suitable for production use |

A dedicated graph database or vector store may be warranted once traversal depth or embedding query volume exceeds what pgvector and recursive CTEs can serve efficiently. That is a post-v1 decision.

### Schema strategy

- Each entity, claim, and artifact is a row in a typed table.
- JSONB columns hold flexible metadata and claim payloads without requiring schema migrations for every new claim type.
- Derivation links are a first-class table, not implicit in application code.
- Embeddings are stored in a `pgvector` column on the entity and claim tables.

---

## 2. Raw Ingest Envelope

Every artifact ingested into the raw evidence layer is wrapped in a standard envelope. No source-specific schema leaks outside this envelope.

### Envelope schema

```json
{
  "envelope_version": "1",
  "artifact_id":       "<uuid-v4>",
  "project_id":        "<project_id>",
  "source_type":       "<source_type>",
  "source_uri":        "<canonical_source_identifier>",
  "content_hash":      "<sha256_hex>",
  "content":           "<raw_text_content | null>",
  "content_ref":       "<object_store_path | null>",
  "ingested_at":       "<iso8601_utc>",
  "source_modified_at":"<iso8601_utc | null>",
  "extractor":         "<extractor_name>@<version>",
  "provenance":        { ... },
  "tags":              ["<tag>"]
}
```

### Provenance sub-object

The `provenance` object is source-type-specific. Each source type defines its own provenance schema. Two examples:

**git-repo source:**
```json
{
  "repo_url":   "https://github.com/org/repo",
  "commit_sha": "<40-char sha>",
  "file_path":  "docs/adrs/0001-context-system-for-ai-workers.md",
  "start_line": 1,
  "end_line":   347
}
```

**linear source:**
```json
{
  "team_key":    "COR",
  "issue_id":    "COR-731",
  "issue_url":   "https://linear.app/...",
  "updated_at":  "<iso8601_utc>"
}
```

### Field rules

- `artifact_id` is stable across re-ingests of the same logical artifact from the same source. Implementors derive it deterministically from `(project_id, source_type, source_uri)` using a UUID v5 namespace.
- `content_hash` changes when the content changes. A changed hash triggers downstream staleness propagation.
- `content` holds inline text for small artifacts. `content_ref` holds a path for large binary artifacts. Exactly one is non-null.
- `extractor` records which extractor version produced this envelope, enabling re-ingestion when extractor logic changes.

---

## 3. Entity and Relationship Types

### Entity types

The summary layer uses a typed entity model. All entities share a common base, and type-specific fields are carried in a JSONB `attributes` column.

#### v1 entity types

| Type | Description |
|---|---|
| `project` | The context namespace. One per configured project. |
| `component` | A major functional or structural part of the project (service, library, module, subsystem). |
| `decision` | An architectural or design decision. ADRs are the canonical source. |
| `constraint` | A requirement, invariant, or hard limitation that shapes the project. |
| `interface` | A named API, protocol, or contract between components. |
| `workflow` | A defined process or pipeline in the project. |

Types deferred to post-v1: `symbol`, `risk`, `dependency` (external package), `schema`.

#### Entity base attributes

Every entity carries:

- `entity_id` (uuid)
- `project_id`
- `entity_type`
- `name`
- `description`
- `review_status`: `candidate | reviewed | rejected`
- `freshness`: `current | stale`
- `attention_state`: `null | needs_attention | conflicted`
- `created_at`, `updated_at`
- `embedding` (pgvector, 1536-dim for `text-embedding-3-small`)

#### Claims

Consequential facts about an entity are stored as separate `claim` rows rather than inline entity fields. This enables claim-level citation and review.

```
entity_id + claim_type + claim_value + source_artifact_ids + review_status + freshness
```

Example claim types: `has_responsibility`, `has_constraint`, `implements_interface`, `superseded_by`, `depends_on`.

### Relationship types

| Type | Domain | Range | Description |
|---|---|---|---|
| `CONTAINS` | project, component | component | Structural containment |
| `DEPENDS_ON` | component, workflow | component, interface | Runtime or build dependency |
| `IMPLEMENTS` | component | interface | Component satisfies an interface |
| `DOCUMENTS` | decision | component, interface, workflow | Decision governs a subject |
| `CONSTRAINS` | constraint | component, interface, workflow | Constraint applies to a subject |
| `SUPERSEDES` | decision | decision | Newer decision replaces older |
| `RELATED_TO` | any | any | General association, weakly typed |
| `POSSIBLE_DUPLICATE_OF` | any | any | Candidate merge, not yet resolved |

Relationships carry: `relationship_id`, `source_entity_id`, `target_entity_id`, `type`, `review_status`, `freshness`, `citation_artifact_ids`.

---

## 4. First Source-Specific Extractors for v1

**v1 extractor: `markdown-doc` extractor**

The first extractor reads Markdown files from a configured git repository. This was chosen because:

- Every software project has Markdown documentation (READMEs, ADRs, specs).
- It requires no external API credentials.
- It covers the highest-value low-hanging fruit: architectural decisions recorded as ADRs.
- It enables a fully self-contained bootstrap test against ContextLoom's own repo.

#### What the `markdown-doc` extractor does

1. Walks the configured file glob patterns in a git repo (default: `**/*.md`, `**/*.mdx`).
2. For each file, emits a raw artifact envelope with the file content and git provenance.
3. Produces entity extraction candidates via an LLM pass that identifies: decisions (from ADR frontmatter or heading patterns), components (named subsystems), constraints, and interfaces mentioned in the text.
4. Records derivation links from each artifact to each extracted entity/claim.

#### v1 extractor scope

The markdown-doc extractor is the only extractor shipping in v1. A second extractor (Linear issues or GitHub issues) is the first post-v1 addition, but is out of scope until v1 is end-to-end working.

---

## 5. Worker-Facing Read APIs

The read surface is exposed as MCP tools and MCP resources. The split rule:

> **MCP Tools** — parameterized operations that require input to identify what to return (search, lookup by ID, traversal from a node). These are action-like even when read-only.
>
> **MCP Resources** — stable addresses for well-known collections or individual entities. These are browsable and cacheable.

### MCP Tools (v1)

#### `get_entity`

Retrieve a single entity by ID.

```
Input:
  entity_id:        string  (required)
  include_claims:   boolean (default: true)
  include_citations: boolean (default: false)

Output:
  entity:    Entity
  claims:    Claim[]          (if include_claims)
  citations: ArtifactRef[]    (if include_citations)
```

#### `get_related_entities`

Traverse the graph from an entity.

```
Input:
  entity_id:           string   (required)
  relationship_types:  string[] (default: all)
  direction:           "outbound" | "inbound" | "both" (default: "both")
  depth:               integer  (default: 1, max: 3)
  trust_filter:        TrustFilter (default: reviewed + current)

Output:
  root:     Entity
  edges:    RelationshipEdge[]
  entities: Entity[]
```

#### `search_context`

Semantic and lexical search over the summary layer.

```
Input:
  query:        string   (required)
  entity_types: string[] (default: all)
  project_id:   string   (optional, scoped to project if set)
  trust_filter: TrustFilter (default: reviewed + current)
  limit:        integer  (default: 10, max: 50)

Output:
  results: SearchResult[]  (entity + score + matched_claims + citations)
```

#### `search_artifacts`

Lexical search over the raw evidence layer.

```
Input:
  query:        string   (required)
  source_types: string[] (default: all)
  project_id:   string   (optional)
  limit:        integer  (default: 10, max: 50)

Output:
  results: ArtifactResult[]  (artifact_id + source_uri + snippet + provenance)
```

#### `get_project_overview`

Returns the top-level summary of a project: components, decisions, active constraints.

```
Input:
  project_id: string (required)

Output:
  project:      Entity
  components:   Entity[]
  decisions:    Entity[]
  constraints:  Entity[]
  freshness_summary: FreshnessSummary
```

### MCP Resources (v1)

Resources are addressable by URI. They return the current state of the identified object without additional input parameters.

| Resource URI | Returns |
|---|---|
| `context://projects/{project_id}` | Project entity + overview |
| `context://projects/{project_id}/components` | All component entities in the project |
| `context://projects/{project_id}/decisions` | All decision entities in the project |
| `context://projects/{project_id}/constraints` | All constraint entities in the project |
| `context://entities/{entity_id}` | Single entity with claims |
| `context://entities/{entity_id}/claims` | Claims for an entity |
| `context://entities/{entity_id}/relationships` | Direct relationships for an entity |

Resource URIs use `project_id` values from the project config (see Section 8). `entity_id` values are UUIDs from the summary layer.

### TrustFilter type

Used by tools to filter on review/freshness state.

```
TrustFilter:
  review_status:   ("candidate" | "reviewed")[]  (default: ["reviewed"])
  freshness:       ("current" | "stale")[]        (default: ["current"])
  include_conflicted: boolean                      (default: false)
```

Workers should use the defaults unless they explicitly need candidate or stale context.

---

## 6. Retrieval Strategy

The system supports four retrieval modes, ranked in order of preference:

### Rank 1: Direct entity lookup

When the entity ID is known, use `get_entity`. This is the highest-precision path: no ambiguity, no ranking, no false positives. Workers should cache and prefer entity IDs when they have them.

### Rank 2: Graph traversal

When navigating from a known entity to related entities, use `get_related_entities`. Graph traversal is more precise than search because it follows explicit, reviewed relationships rather than similarity. Workers should prefer it when the question is relational ("what depends on this component?", "which decision governs this interface?").

### Rank 3: Lexical search

For queries involving specific identifiers, names, or technical terms, use `search_context` with an exact or near-exact string. Lexical search via `tsvector` is deterministic and does not hallucinate entity names. Workers should try lexical before semantic when they have a concrete name to match.

### Rank 4: Semantic search

Use semantic search (embedding similarity via pgvector) for discovery when the worker does not know entity names or is asking a conceptual question. Semantic search is last in the cascade because it trades precision for recall. Results should always be accompanied by `review_status` and `freshness` signals so workers can filter unreliable hits.

### Cascade behavior

When a worker tool needs to answer a query, the implementation should:

1. Check if an `entity_id` is directly provided → direct lookup.
2. Check if the query is relational from a known entity → graph traversal.
3. Attempt lexical search and return if results are high-confidence.
4. Fall through to semantic search as a last resort.

The MCP tools expose each mode separately. The cascade is a recommended worker usage pattern, not an enforced server behavior.

---

## 7. Reconciliation Rules for Cross-Source Entity Identity

**Principle: merge only on strong evidence. Preserve candidates when uncertain.**

### Strong evidence (auto-merge allowed)

| Signal | Example |
|---|---|
| Explicit stable ID shared across sources | ADR number referenced in both a spec and an issue |
| Source-native identifier that is globally stable | Linear issue ID `COR-123` appears in commit message and issue body |
| Exact file path + symbol | A function name appears identically in two extractors from the same file |
| Explicit cross-source link declared in content | A spec document says "see ADR 0001" |

When two entity candidates share a strong signal, they are merged into one entity. The merged entity retains both source citations.

### Weak evidence (do not auto-merge)

| Signal | Why insufficient |
|---|---|
| Name similarity | "Auth service" ≠ "Authentication Service" without more context |
| Embedding similarity | Semantic neighbors are not necessarily the same entity |
| Heuristic co-occurrence | Appearing in the same document does not imply identity |

### When identity is uncertain

Do not silently collapse. Instead:

1. Keep both entities as separate candidates.
2. Create a `POSSIBLE_DUPLICATE_OF` relationship between them with `review_status: candidate`.
3. Set `attention_state: needs_attention` on both entities.
4. Surface the pair for human or reviewer resolution.

Once a reviewer confirms or rejects the merge, the `POSSIBLE_DUPLICATE_OF` relationship is updated to `reviewed` and either the entities are merged or the relationship is removed.

---

## 8. Staleness Dependency Model

### Derivation link types

Staleness propagates through derivation, not through graph relationships. The system tracks derivation links in a `derivation` table:

| Source | Target | Link type |
|---|---|---|
| `artifact` | `claim` | `CLAIM_DERIVED_FROM` |
| `artifact` | `relationship` | `RELATIONSHIP_INFERRED_FROM` |
| `claim` | `entity_attribute` | `ATTRIBUTE_CONTRIBUTED_BY` |
| `claim` | `relationship` | `RELATIONSHIP_SUPPORTED_BY` |

### Staleness propagation algorithm

When an artifact's `content_hash` changes on re-ingest:

1. Mark all claims with `CLAIM_DERIVED_FROM` this artifact as `stale`.
2. For each newly-stale claim, walk `ATTRIBUTE_CONTRIBUTED_BY` and `RELATIONSHIP_SUPPORTED_BY` links and mark their targets as `stale`.
3. Repeat step 2 for any newly-stale items (BFS, bounded depth).

**Stop conditions:**

- A reviewed claim is never automatically marked stale if the reviewer explicitly confirmed it on or after the artifact's last modification date. Reviewers must re-confirm after changes; the system marks the item `needs_attention` instead.
- Staleness does not propagate through `DEPENDS_ON`, `CONTAINS`, or other semantic relationship edges. An entity whose dependency changes is not itself stale; only items with explicit derivation links go stale.

### Rationale for this model

Using derivation links rather than timestamps prevents two failure modes: (1) timestamps miss transitive dependencies, and (2) graph-edge propagation over-invalidates unrelated entities. Derivation links make the propagation surface explicit and auditable.

---

## 9. Source-Precedence Policy

There is no global "code always wins" rule. Precedence depends on the kind of claim.

### Precedence tiers by claim type

| Claim type | Preferred sources (in priority order) |
|---|---|
| Implementation facts (API shapes, function signatures, config values, environment behavior) | Code, config files, schemas, tests |
| Intended architecture (what should be true, not what is currently true) | ADRs and approved design specs |
| Intended behavior (expected inputs/outputs, contracts) | Specs, tests, interface definitions |
| Advisory context (rationale, planning notes, discussion) | Issue tracker, PR descriptions, comments — lowest precedence |

### Conflict handling

When two sources produce contradictory claims of the same type:

1. Both claims are preserved with their source labels and `review_status: candidate`.
2. The parent entity's `attention_state` is set to `conflicted`.
3. Neither claim is automatically promoted to `reviewed`.
4. A reviewer must inspect and accept one (or reject both) to clear the conflicted state.

This applies even when one source is in a higher-precedence tier. The system surfaces the conflict; it does not resolve it silently.

---

## 10. Project Scoping Semantics

### What is a project

A project is a configured context namespace identified by a stable `project_id`. It is not necessarily a single repository. A project may span multiple repositories, multiple source systems, or multiple artifact types that should be reasoned about together.

Projects are the unit of:
- entity namespace isolation
- ingestion configuration
- worker retrieval scope
- cross-project link management

### Configuration format

Each project is defined by a `contextloom.yaml` file at the root of the primary repository (or in a standalone config directory). This file is the authoritative source for project identity and source configuration.

```yaml
# contextloom.yaml
project_id: "my-project"          # stable, used in entity URIs and MCP resources
name: "My Project"
description: "..."

sources:
  - type: git-repo
    path: "."                      # relative to this config file
    globs: ["**/*.md", "**/*.yaml"]
    extractors: ["markdown-doc"]

  - type: git-repo
    path: "../other-repo"
    extractors: ["markdown-doc"]

  - type: linear
    team_key: "COR"
    extractors: ["linear-issue"]   # post-v1

cross_project_links:
  - project_id: "platform"
    relationship: "depends-on"
```

### Namespace rules

- All entities within a project share the `project_id` namespace. Entity URIs are `context://entities/{entity_id}` where the entity record carries the `project_id`.
- Cross-project relationships are declared explicitly in `cross_project_links`. They do not create implicit entity merges.
- There is no automatic cross-project graph unification. A worker querying project A does not receive entities from project B unless it explicitly queries project B.
- Cross-project `RELATED_TO` or `DEPENDS_ON` relationships are allowed and stored with both `source_project_id` and `target_project_id` fields. These are first-class relationship records, not pointers into a merged graph.

### Project identity stability

`project_id` must be stable once set. It is referenced in stored entity IDs, derivation links, and MCP resource URIs. Changing a project ID requires a migration.

---

## 11. v1 Implementation Scope (Smallest End-to-End Loop)

The v1 milestone is the smallest system that demonstrates the full pipeline: ingest → extract → store → query.

### Entity types in scope for v1

- `project`
- `component`
- `decision`
- `constraint`

Types out of scope for v1: `interface`, `workflow`, `symbol`, `risk`.

### Extractors in scope for v1

- `markdown-doc` extractor only (reads `.md` files from a git repo)

The extractor:
1. Reads each Markdown file matching configured globs.
2. Emits a raw artifact envelope per file.
3. Runs an LLM extraction pass to produce entity candidates for the four in-scope entity types.
4. Records derivation links (artifact → claim).

### MCP tools shipping in v1

- `get_entity`
- `get_related_entities`
- `search_context`
- `get_project_overview`

`search_artifacts` is deferred to post-v1 (raw evidence layer search is lower priority than summary layer search for initial workers).

### MCP resources shipping in v1

- `context://projects/{project_id}`
- `context://projects/{project_id}/components`
- `context://projects/{project_id}/decisions`
- `context://entities/{entity_id}`

### Storage backend for v1

Single PostgreSQL instance with `pgvector` extension. No sharding, no read replicas. This is appropriate for the expected v1 data volume (one project, hundreds to low thousands of entities).

### v1 end-to-end scenario

A worker can:

1. Bootstrap a project by running `contextloom ingest --config contextloom.yaml` against a git repo containing Markdown files.
2. Query for all decisions via `get_project_overview` or `context://projects/{project_id}/decisions`.
3. Retrieve a specific decision entity with its claims and citations via `get_entity`.
4. Search for context about an unfamiliar term via `search_context`.
5. Traverse from a component to its decisions via `get_related_entities`.

This loop covers the full pipeline and is sufficient to validate the architecture before adding more extractors or entity types.

---

## Appendix: Open Questions Resolved

This document resolves the eight open questions from ADR 0001:

| # | Open question | Where resolved |
|---|---|---|
| 1 | Raw ingest envelope and provenance metadata | Section 2 |
| 2 | Initial entity and relationship schema | Section 3 |
| 3 | First source-specific extractor(s) | Section 4 |
| 4 | Worker-facing read APIs and response shapes | Section 5 |
| 5 | Retrieval strategy ranking | Section 6 |
| 6 | Reconciliation rules for cross-source identity | Section 7 |
| 7 | Dependency model for staleness propagation | Section 8 |
| 8 | Source-precedence policy for different claim types | Section 9 |

Additional decisions not in the original open questions:

| Topic | Where resolved |
|---|---|
| Storage substrate | Section 1 |
| MCP tool/resource split | Section 5 |
| Project scoping semantics | Section 10 |
