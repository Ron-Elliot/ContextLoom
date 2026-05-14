# Context Loom

A project-state knowledge system for AI workers.

Most agent orchestration tools track work state — issues, branches, runs, PRs. Context Loom tracks project state — what the project is, what decisions have been made, what constraints exist, what's currently true. The two compose: an orchestrator dispatches work; Context Loom grounds the worker's reasoning in current project truth.

The system ingests evidence from many sources (source code, configs, schemas, checked-in docs, issue trackers, agent run records) into a raw evidence layer, then extracts a summary layer of typed entities, claims, and relationships. Each claim carries citations back to its source artifacts and a freshness signal that propagates when those sources change. AI workers reach into Context Loom via an MCP server — read-only, typed, citation-rich responses.

Context Loom is independent of any single orchestration system. Any tool that produces evidence about a project can serve as an ingestion source; any AI worker that speaks MCP can read.

## Status

**Proposed.** The architecture is described in [ADR 0001](docs/adrs/0001-context-system-for-ai-workers.md). No implementation yet — open questions are being resolved, then a project spec will drive the build.

## Repository layout

- `docs/adrs/` — Architectural decision records. Numbered, dated, immutable once accepted.

More directories will arrive as the implementation lands.

## License

[MIT](LICENSE)
