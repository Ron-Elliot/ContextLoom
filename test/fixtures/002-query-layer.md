# Query Layer

The query layer is the read-side of the ContextLoom system. It provides entity
lookup, full-text search, semantic vector search, and graph traversal over the
knowledge graph stored in PostgreSQL with pgvector.

## Responsibilities

- Full-text search via PostgreSQL `tsvector` / `plainto_tsquery`
- Semantic search via pgvector cosine distance on entity embeddings
- BFS traversal over the relationships table for related-entity discovery
- Single entity and artifact fetch by ID
- Trust filter application to exclude candidate/rejected entities

## Dependencies

- PostgreSQL 16 with pgvector extension
- `pg` Node.js driver for database access
- OpenAI API for query embedding (semantic search only)
