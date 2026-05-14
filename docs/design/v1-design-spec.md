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
  "envelope_version":    "1",
  "artifact_id":         "<uuid-v5-stable>",
  "artifact_version_id": "<uuid-v4>",
  "project_id":          "<project_id>",
  "source_type":         "<source_type>",
  "source_uri":          "<logical_artifact_identifier>",
  "content_hash":        "<sha256_hex>",
  "content":             "<raw_text_content | null>",
  "content_ref":         "<object_store_path | null>",
  "ingested_at":         "<iso8601_utc>",
  "source_modified_at":  "<iso8601_utc | null>",
  "extractor":           "<extractor_name>@<version>",
  "provenance":          { ... },
  "tags":                ["<tag>"]
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
  "branch":     "main",
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

These two fields solve different identity problems:

- `artifact_id` — stable logical identity for a given artifact across all ingests. Derived deterministically as a UUID v5 from `(project_id, source_type, source_uri)`. This is the key for deduplication, reconciliation, and derivation links. It must be stable as long as the logical artifact exists at that URI.
- `artifact_version_id` — unique identity for a specific ingest row. A new UUID v4 on every ingest. This is the key for append-only history and version-specific provenance lookup.

`source_uri` must identify the **logical artifact**, not a version. For git files, `source_uri` is the repository-relative file path (e.g., `docs/adrs/0001-context-system-for-ai-workers.md`), not a URI that includes a commit SHA. The commit SHA belongs in `provenance.commit_sha`. If `source_uri` included the commit SHA, each commit would generate a new logical artifact rather than a new version of the same artifact — breaking deduplication and staleness propagation.

Other field rules:

- `content_hash` identifies the actual content state. A changed hash on re-ingest triggers downstream staleness propagation.
- `content` holds inline text for small artifacts. `content_ref` holds a path for large binary artifacts. Exactly one is non-null.
- `extractor` records which extractor version produced this envelope, enabling re-ingestion when extractor logic changes.

---

## 3. Entity and Relationship Types

### Entity types

The summary layer uses a typed entity model. All entities share a common base, and type-specific fields are carried in a JSONB `attributes` column.

#### Entity types

V1 ships four entity types. The full planned type surface (including post-v1 types) is listed below; Section 11 is the authoritative v1 scope.

| Type | Scope | Description |
|---|---|---|
| `project` | v1 | The context namespace. One per configured project. |
| `component` | v1 | A major functional or structural part of the project (service, library, module, subsystem). |
| `decision` | v1 | An architectural or design decision. ADRs are the canonical source. |
| `constraint` | v1 | A requirement, invariant, or hard limitation that shapes the project. |
| `interface` | post-v1 | A named API, protocol, or contract between components. |
| `workflow` | post-v1 | A defined process or pipeline in the project. |

Types deferred to post-v1: `interface`, `workflow`, `symbol`, `risk`, `dependency` (external package), `schema`.

#### Entity base attributes

Every entity carries:

- `entity_id` (uuid)
- `project_id`
- `entity_type`
- `name`
- `description`
- `review_status`: `candidate | reviewed | rejected`
- `last_verified_at`: timestamp or null — when a reviewer last confirmed this entity was correct
- `last_evidence_change_at`: timestamp or null — when the underlying evidence last changed
- `attention_state`: `null | conflicted` — set to `conflicted` when contradictory claims exist; cleared by reviewer resolution
- `created_at`, `updated_at`
- `embedding` (pgvector, 1536-dim for `text-embedding-3-small`)

Staleness is derived, not stored: an entity is considered stale when `last_evidence_change_at IS NOT NULL AND (last_verified_at IS NULL OR last_evidence_change_at > last_verified_at)`. This lets the system query for items older than a review threshold (e.g., verified more than 7 days before the most recent evidence change) without requiring a stored enum to stay synchronized.

#### Claims

Claims are a single record type with a **generic subject model**: the subject of a claim can be either an entity or an artifact.

```
subject_type + subject_id + claim_type + claim_value + source_artifact_ids + review_status + last_verified_at + last_evidence_change_at
```

- `subject_type`: `entity | artifact`
- `subject_id`: the UUID of the entity or artifact this claim is attached to

This single schema handles both:
- **Entity claims** (`subject_type = entity`): consequential facts about a summary-layer entity — e.g., `has_responsibility`, `has_constraint`, `implements_interface`, `superseded_by`.
- **Artifact claims** (`subject_type = artifact`): facts extracted directly from a raw artifact record — e.g., `summary` (the LLM-generated file summary), `imports` (list of imported file paths), `exported_symbols`, `config_key_value`.

There is no separate artifact-claim record type. Both entity claims and artifact claims use the same `claim` table, distinguished by `subject_type`. The choice between them follows naturally: if the fact is about a summary-layer entity, the subject is that entity; if the fact is about a raw file (and there is no entity to attach it to), the subject is the artifact.

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

In v1, relationship endpoints are limited to the four v1 entity types (`project`, `component`, `decision`, `constraint`). Relationships whose domain or range includes `interface` or `workflow` apply only when those post-v1 entity types are available. For example, `DEPENDS_ON` in v1 has effective domain `component` and effective range `component`.

Relationships carry: `relationship_id`, `source_entity_id`, `target_entity_id`, `type`, `review_status`, `last_verified_at`, `last_evidence_change_at`, `citation_artifact_ids`.

---

## 4. First Source-Specific Extractors for v1

**v1 extractor: `repo-file` extractor**

The first extractor ingests all in-scope files from a configured git repository and builds a repo-wide file-intelligence baseline. A markdown-only extractor was considered but rejected: it treats non-Markdown files as opaque raw artifacts, which produces a documentation-intelligence system rather than a project-state-intelligence system. V1 must validate repo-wide artifact coverage, per-file summaries, and file-to-file relationships — not just ADR extraction.

The extractor is chosen because:

- It requires no external API credentials.
- It can bootstrap against any git repository, including ContextLoom's own repo.
- It validates the full pipeline across all file types the system will eventually need to understand.

#### What the `repo-file` extractor does

Every in-scope file gets:

1. A raw artifact envelope with the file content and git provenance (see Section 2).
2. A short LLM-generated summary (1-3 sentences) stored as a `summary` claim on the artifact record, with a citation back to the specific `artifact_version_id`.
3. File-type-specific claims (import lists, key-value pairs, behavioral descriptions) — see extraction depth table below.

#### Files are artifacts, not entities

Files live in the **raw evidence layer** as artifact records. They are not entities in the summary layer. The summary layer contains entities (`component`, `decision`, `constraint`, `project`) which are derived from or supported by artifact evidence — but a file itself is not an entity.

This distinction shapes how file-to-file relationships work in v1:

- There is no file entity type. The `DEPENDS_ON` relationship in Section 3 has domain `component` and range `component` — it relates summary-layer entities, not raw files.
- Import-level dependencies extracted from code files are stored as **import claims** on the artifact record (a claim listing the file paths imported by that file). They are not entity-level `DEPENDS_ON` relationships.
- Entity-level `DEPENDS_ON` relationships between `component` entities are a post-v1 concern. They require a component-mapping step that groups files into components and aggregates file-level import claims into component-to-component relationships.

In v1, the import claims on artifact records are sufficient to answer "what does this file depend on?" and to validate that the extraction pipeline captures dependency structure. Entity-level dependency relationships between components are the next step.

Extraction depth varies by file type:

| File type | Extraction |
|---|---|
| `.md`, `.mdx` | Full entity extraction: decisions (ADR frontmatter or heading patterns), components, constraints; derivation links from artifact to each entity/claim |
| Code files (`.ts`, `.tsx`, `.js`, `.py`, `.go`, `.rb`, etc.) | Summary + import claims: a claim on the artifact record listing imported file paths; list of exported symbols as claims |
| Config files (`.yaml`, `.json`, `.toml`, `.env`, etc.) | Summary + key-value extraction: notable config keys and values as claims |
| Test files (`*.test.*`, `*.spec.*`, `*_test.*`) | Summary + behavioral assertion descriptions: what the test covers as a claim |
| All other in-scope files | Summary only |

This gives the system:
- Repo-wide artifact coverage with no second-class files
- Per-file summaries queryable through the summary layer
- File-level import dependency data stored as claims on artifact records
- A path from file intelligence to higher-order entities (a component may map to a directory or package; decisions map from ADRs)

#### v1 extractor scope

The `repo-file` extractor is the only extractor shipping in v1. A second extractor (Linear issues or GitHub issues) is the first post-v1 addition, out of scope until the repo-file pipeline is end-to-end working.

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
  claims:    EntityClaim[]    (if include_claims — claims where subject_type = entity)
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
  trust_filter:        TrustFilter (default: reviewed, max_staleness_days: 7)

Output:
  root:     Entity
  edges:    RelationshipEdge[]
  entities: Entity[]
```

#### `search_context`

Semantic and lexical search over the entity summary layer. Searches entities and entity claims (`subject_type = entity`) only. Artifact claims (`subject_type = artifact`) are not indexed for search; access them via `get_artifact`.

```
Input:
  query:        string   (required)
  entity_types: string[] (default: all)
  project_id:   string   (optional, scoped to project if set)
  trust_filter: TrustFilter (default: reviewed, max_staleness_days: 7)
  limit:        integer  (default: 10, max: 50)

Output:
  results: SearchResult[]  (entity + score + matched_entity_claims + citations)
```

#### `get_artifact`

Fetch a specific raw artifact by ID, including its extracted claims. Used for targeted evidence access when a worker needs to read the source text behind a cited claim or entity. Discovery happens in the summary layer; raw artifacts are fetched by citation rather than searched as a main interface.

```
Input:
  artifact_id:         string  (required)
  artifact_version_id: string  (optional — fetches latest version if omitted)

Output:
  artifact: ArtifactEnvelope          (envelope + content or content_ref + provenance)
  claims:   ArtifactClaim[]           (all claims with subject_type = artifact for this artifact_id)
```

`ArtifactClaim` is the standard `Claim` record filtered to `subject_type = artifact`. For a code file this would include the `summary` claim and any `imports` claims. For a Markdown file it would include the `summary` claim. The full claim schema is defined in Section 3.

Artifact claims are **not** searched by `search_context`. The `search_context` tool operates on the entity summary layer only (entities and entity claims where `subject_type = entity`). To access artifact claims, use `get_artifact` with the `artifact_id` from a citation. This keeps the worker read path summary-first: workers discover context through entity search, then pull raw evidence and artifact-level claims by citation when needed.

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
  staleness_summary: StalenessSummary  (counts of stale / current / unverified items)
```

### MCP Resources

Resources are addressable by URI. They return the current state of the identified object without additional input parameters.

The table below shows the **full planned resource surface**. V1 ships a subset of these; Section 11 is the authoritative v1 resource list. This section documents what the eventual surface looks like so implementers can design URI structure consistently from the start.

| Resource URI | Returns | Scope |
|---|---|---|
| `context://projects/{project_id}` | Project entity + overview | v1 |
| `context://projects/{project_id}/components` | All component entities in the project | v1 |
| `context://projects/{project_id}/decisions` | All decision entities in the project | v1 |
| `context://projects/{project_id}/constraints` | All constraint entities in the project | post-v1 |
| `context://entities/{entity_id}` | Single entity with claims | v1 |
| `context://entities/{entity_id}/claims` | Claims for an entity | post-v1 |
| `context://entities/{entity_id}/relationships` | Direct relationships for an entity | post-v1 |

Resource URIs use `project_id` values from the project config (see Section 10). `entity_id` values are UUIDs from the summary layer.

### TrustFilter type

Used by tools to filter on review and staleness state. Staleness is derived from timestamps (see Section 8), not a stored enum.

```
TrustFilter:
  review_status:      ("candidate" | "reviewed")[]  (default: ["reviewed"])
  max_staleness_days: integer | null                 (default: 7; null = no freshness filter)
  include_conflicted: boolean                        (default: false)
```

`max_staleness_days` filters out items where `last_evidence_change_at > last_verified_at + interval`. Workers should use the defaults unless they explicitly need candidate or potentially stale context. A `max_staleness_days: null` call is appropriate for exploratory queries where the worker wants full coverage and will evaluate trust signals in the response.

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

Use semantic search (embedding similarity via pgvector) for discovery when the worker does not know entity names or is asking a conceptual question. Semantic search is last in the cascade because it trades precision for recall. Results should always be accompanied by `review_status`, `last_verified_at`, and `last_evidence_change_at` signals so workers can evaluate the trustworthiness of hits.

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
3. Surface the pair for human or reviewer resolution. The presence of a `candidate` `POSSIBLE_DUPLICATE_OF` relationship is the signal; no additional `attention_state` flag is required.

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

### Freshness fields

Claims, entities, and relationships each carry two timestamp fields:

- `last_evidence_change_at` — set to `now()` when a derivation ancestor's `content_hash` changes. Records when the evidence underlying this item last changed.
- `last_verified_at` — set to `now()` when a reviewer marks the item as reviewed and correct. Records when the item was last confirmed.

An item is considered **stale** when: `last_evidence_change_at IS NOT NULL AND (last_verified_at IS NULL OR last_evidence_change_at > last_verified_at)`.

This is derived on read, not stored. No separate `freshness` enum exists. Items needing re-verification are queryable as: `WHERE last_evidence_change_at > last_verified_at AND review_status = 'reviewed'` — enabling batch re-verification workflows without relying on a synchronized stored flag.

### Staleness propagation algorithm

When an artifact's `content_hash` changes on re-ingest:

1. Set `last_evidence_change_at = now()` on all claims with `CLAIM_DERIVED_FROM` this artifact.
2. For each updated claim, walk `ATTRIBUTE_CONTRIBUTED_BY` and `RELATIONSHIP_SUPPORTED_BY` links and set `last_evidence_change_at = now()` on their targets.
3. Repeat step 2 for any newly-updated items (BFS, bounded depth).

**Stop condition:**

Propagation stops at any item where `last_verified_at >= last_evidence_change_at` (i.e., the reviewer's last verification post-dates or equals the last evidence change). Those items are current: the reviewer's confirmation already accounts for this evidence state, so updating `last_evidence_change_at` again would be incorrect. Propagation does not skip them — it simply does not need to recurse further through them, because their dependents were verified against already-current evidence.

Staleness does not propagate through `DEPENDS_ON`, `CONTAINS`, or other semantic relationship edges. An entity whose dependency changes is not itself stale; only items with explicit derivation links receive updated timestamps.

### Rationale for timestamp model

A stored binary `freshness` enum requires the propagation pass to keep the stored value synchronized and introduces the problem of defining a valid stop condition against a field that may not be set. Timestamps solve this:

- The stop condition is unambiguous: `last_verified_at >= last_evidence_change_at` is always evaluable.
- The propagation writes `last_evidence_change_at`; reviewers write `last_verified_at`. The two writes are independent and never conflict.
- Re-verification batches are a simple range query, not a traversal.
- Drift detection — "evidence changed more than N days after verification" — is a single threshold comparison.

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
    extractors: ["repo-file"]

  - type: git-repo
    path: "../other-repo"
    extractors: ["repo-file"]

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

- `repo-file` extractor (reads all in-scope files from a git repo)

The extractor for each file:
1. Emits a raw artifact envelope (with stable `artifact_id` derived from logical file path, not commit SHA).
2. Generates a short LLM summary stored as a claim.
3. Runs file-type-specific deeper extraction:
   - `.md`/`.mdx`: entity candidates for the four in-scope types; derivation links from artifact to each claim
   - Code files: import claims on the artifact record (a claim listing imported file paths); exported symbol list as claims
   - Config and test files: summary claims only in v1 (deeper extraction post-v1)
4. Records derivation links (artifact → claim → entity).

### MCP tools shipping in v1

- `get_entity`
- `get_related_entities`
- `search_context`
- `get_project_overview`
- `get_artifact`

The system is summary-first: discovery happens in the summary layer (`search_context`, `get_entity`, `get_related_entities`) and raw artifacts are fetched by citation when needed (`get_artifact`). There is no `search_artifacts` tool — searching raw artifacts as a parallel discovery workflow is not a v1 worker use case.

### MCP resources shipping in v1

- `context://projects/{project_id}`
- `context://projects/{project_id}/components`
- `context://projects/{project_id}/decisions`
- `context://entities/{entity_id}`

### Storage backend for v1

Single PostgreSQL instance with `pgvector` extension. No sharding, no read replicas. This is appropriate for the expected v1 data volume (one project, hundreds to low thousands of entities).

### v1 end-to-end scenario

A worker can:

1. Bootstrap a project by running `contextloom ingest --config contextloom.yaml` against a git repo. The `repo-file` extractor processes every in-scope file: Markdown files produce entity candidates; code files produce summaries and import claims on their artifact records.
2. Query for all decisions via `get_project_overview` or `context://projects/{project_id}/decisions`.
3. Retrieve a specific decision entity with its claims and citations via `get_entity`.
4. Search for context about an unfamiliar term via `search_context`.
5. Traverse from a component to its decisions via `get_related_entities`.
6. Fetch the source text behind a cited claim via `get_artifact` using the `artifact_id` from the citation.

This loop covers the full pipeline — including repo-wide file coverage and artifact citation retrieval — and is sufficient to validate the architecture before adding more extractors or entity types.

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
