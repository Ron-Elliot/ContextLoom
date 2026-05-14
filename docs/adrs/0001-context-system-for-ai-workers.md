# ADR 0001: Context System For AI Workers

## Status

Proposed

## Context

AI workers need access to durable project understanding that is broader than any single run, issue, or execution workflow.

That understanding should not be modeled as work state such as:

- active issues
- active branches
- open pull requests
- in-flight runs

Instead, the system should represent current project state and support projects regardless of how they are executed or which operational tooling they use.

It must also support projects that were not started inside one orchestration system. Bootstrap ingestion from existing project artifacts is a first-class requirement.

## Decision

Build an independent context system for AI workers.

The context system will:

- serve as the primary system for durable project-state understanding
- model project state rather than work state
- be entity-first and AI-worker-first
- ingest evidence from multiple source systems
- maintain a raw evidence layer and a summary layer with review and freshness states
- expose read-oriented query tools for workers

## Rationale

This keeps project understanding separate from operational execution state.

It allows the system to:

- serve multiple workflows and tools
- ingest existing projects without prior orchestration history
- unify code and non-code evidence into one model
- provide explicit trust and freshness signals to workers

## Context Model

The context system is a project-state system, not a work-state system.

Project-state intelligence includes code intelligence when the project is code-based, but it is not limited to code alone.

The system should represent the current semantic state of a project, including things like:

- project
- component
- workflow
- decision
- constraint
- risk
- integration
- interface

That may include code-derived understanding such as:

- symbols and modules
- dependencies and interfaces
- execution flow
- schemas and tests
- code-backed responsibilities and invariants

## Data Layers

The system has two primary layers.

### 1. Raw evidence layer

The raw layer stores ingested artifacts and provenance. It is append-only or near-append-only.

It should support many evidence sources, including:

- repository artifacts
- source code
- checked-in docs and specs
- config
- tests
- issue tracker data
- execution outputs
- future external systems

The raw evidence layer is not the worker-facing context model. It is the substrate from which context is extracted.

### 2. Summary layer

The summary layer stores context-native entities, claims, and relationships representing the current project understanding.

It is optimized for worker retrieval and should remain independent of any single evidence source schema.

Human-readable projections may exist later, but they are optional. The core system is optimized for AI worker reads rather than wiki-style browsing.

## Ingestion Model

The context system must support pluggable ingestion.

That includes two important modes:

- bootstrap ingestion for existing projects
- continuous ingestion for ongoing project changes

The system must be able to ingest a project from project artifacts, build initial context, and then keep that context current over time.

All source artifacts are inputs to the context system. None of them define the canonical context schema.

## Identity And Reconciliation

The system must distinguish between:

- artifact identity
- source reference identity
- semantic entity identity

The same logical thing may appear in multiple artifacts. For example, one decision may be represented in a checked-in ADR, a spec, and an issue discussion.

The system should therefore allow:

- multiple source artifacts
- multiple citations
- one reconciled entity when identity is strong

Reconciliation should merge only on strong evidence such as:

- explicit stable IDs
- source-native identifiers
- exact file and symbol identity
- explicit cross-source links

When identity is uncertain, the system should avoid silent merging. It should preserve separate candidates and may mark them as:

- possible duplicate
- needs attention

## Query Model

The query surface should combine structured retrieval and semantic discovery.

Semantic search is useful and should be supported, but it should not be the only truth interface.

The preferred query stack is:

- direct entity lookup
- relationship and traversal queries
- semantic and lexical discovery over summaries and evidence

The system should prefer returning structured, citation-rich results rather than raw document blobs.

Representative worker tools may include:

- `get_project_context`
- `get_component_context`
- `get_workflow_context`
- `get_decision_context`
- `get_constraint_context`
- `get_related_entities`
- `search_context`
- `search_artifacts`

Semantic search is primarily for discovery. Reviewed, current entities, claims, and relationships remain the main trust interface.

## Project Scope

A project is a configured context namespace, not necessarily a single repository.

A project may span:

- one repository
- multiple repositories
- multiple artifact sources that should be reasoned about together

Cross-project relationships may exist, but they should not imply one merged project graph by default.

The context schema should therefore support both:

- within-project relationships
- explicit cross-project links

## Trust Model

The context system should separate candidate understanding from reviewed understanding.

Important project-state claims should be artifact-based and freshness-aware.

Primary evidence should come from current project artifacts such as:

- source code
- workflow definitions
- config
- schemas
- tests
- checked-in specs

Advisory sources such as planning text, issue discussion, or execution output may inform candidate understanding, but should not automatically become reviewed project truth on their own.

When semantic search or other discovery tools return context, the response should preserve trust signals such as:

- review status
- freshness
- citations
- related entities or source artifacts

## Conflict Handling

Different extractors or sources may produce contradictory claims.

The system should not rely on one global precedence rule such as "code always wins." Source precedence depends on the kind of claim.

Examples:

- implementation facts may prefer code, config, schemas, and tests
- intended architecture may prefer ADRs and approved specs
- advisory context may come from planning notes, issue discussion, or execution output

When sources disagree, the system should avoid silently collapsing them into one truth.

It should support:

- preserving contradictory candidate claims
- marking claim sets or entities as conflicted
- routing unresolved contradictions for review

## Staleness Propagation

Freshness requires dependency tracking, not just timestamps.

The system should track derivation links such as:

- artifact to claim
- artifact to relationship
- claim to derived summary field
- claim to relationship
- relationship to higher-level context bundle

When an artifact changes:

- directly cited claims become stale
- derived relationships or summaries depending on those claims may also become stale
- unrelated neighboring entities should not become stale just because they are connected in the graph

Staleness should propagate through derivation dependencies, not all graph relationships.

## Citation Model

Use hybrid citation.

- entity-level citation for broad descriptive summaries
- claim-level citation for consequential facts
- relationship-level citation for linked project structure

Consequential facts include things like:

- constraints
- decisions
- risks
- interfaces
- workflow behavior
- component responsibilities

## Review Model

Use hybrid review.

- entity-level review for broad descriptive context
- claim-level review for consequential facts
- relationship-level review for important edges between entities

This allows low-risk summaries to stay coarse while keeping trust-critical project truth precise and auditable.

## Freshness And Review State

Do not use a separate promoted state.

Instead, model trust and freshness independently.

### Review status

- candidate
- reviewed
- rejected

### Freshness

- current
- stale

Additional attention states may be needed for cases that are not confidently resolved, such as:

- needs attention
- conflicted

These should not replace review status or freshness. They capture uncertainty or unresolved disagreement.

Default worker read policy should prefer:

- reviewed
- current

## Reviewer Uncertainty

Reviewer failure modes must be handled explicitly.

If a reviewer cannot confidently verify a claim, the system should not force it into reviewed state.

The default behavior should be:

- leave uncertain claims as candidate
- mark ambiguous or contradictory cases as needs attention or conflicted
- reserve reviewed for claims accepted into default retrieval

Confidence may be modeled separately from review status if needed. If introduced, it should refine trust decisions rather than replace review status.

## Consequences

Benefits:

- durable project understanding lives in one place
- the system can serve projects outside any one workflow engine
- project understanding can be grounded in current artifacts rather than conversational memory
- code intelligence can live inside a broader project-state model rather than becoming the whole schema

Tradeoffs:

- the system must own source-specific extractors
- review and freshness invalidation become first-class concerns
- query tool design matters more because retrieval is explicit
- semantic search must be constrained by structure and trust signals to avoid becoming a fuzzy truth surface

## Open Questions

The following areas still need concrete design work:

- the exact raw ingest envelope and provenance metadata
- the initial entity and relationship schema
- the first source-specific extractors
- the worker-facing read APIs and response shapes
- the retrieval strategy across direct lookup, graph traversal, lexical search, and semantic search
- the exact reconciliation rules for cross-source identity
- the dependency model for stale propagation
- the source-precedence policies for different claim types
