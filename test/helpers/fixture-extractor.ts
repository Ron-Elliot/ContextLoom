import path from 'path';
import type { Extractor, ExtractionResult } from '../../src/ingest/extractor';

const FIXTURE_RESULTS: Record<string, ExtractionResult> = {
  '001-hybrid-transport-adr.md': {
    fileCategory: 'markdown',
    summary:
      'ADR 0002: Use a hybrid MCP transport — stdio for local dev, HTTP/SSE when CONTEXTLOOM_HOST is set.',
    entities: [
      {
        entity_type: 'decision',
        name: 'Use Hybrid MCP Transport',
        description:
          'Use stdio locally and StreamableHTTPServerTransport when CONTEXTLOOM_HOST is set, enabling both local claude-desktop and hosted Render deployment.',
        attributes: [
          {
            key: 'rationale',
            value:
              'Neither stdio-only nor HTTP-only satisfies both local dev and hosted deployment simultaneously.',
          },
          {
            key: 'consequences',
            value:
              'Server selects transport based on CONTEXTLOOM_HOST at startup; CONTEXTLOOM_PORT defaults to 8080.',
          },
        ],
      },
    ],
  },
  '002-query-layer.md': {
    fileCategory: 'markdown',
    summary:
      'The query layer provides entity lookup, full-text and semantic search, and BFS graph traversal.',
    entities: [
      {
        entity_type: 'component',
        name: 'Query Layer',
        description:
          'Read-side of ContextLoom: full-text search via tsvector, semantic search via pgvector, and BFS traversal over the relationships graph.',
        attributes: [
          {
            key: 'responsibilities',
            value: 'Full-text search, vector search, BFS related-entity discovery, trust filtering',
          },
          {
            key: 'dependencies',
            value: 'PostgreSQL 16, pgvector, pg driver, OpenAI API (semantic search only)',
          },
        ],
      },
    ],
  },
};

export const fixtureExtractor: Extractor = async (filePath: string): Promise<ExtractionResult> => {
  const basename = path.basename(filePath);
  const result = FIXTURE_RESULTS[basename];
  if (result) return result;
  return { fileCategory: 'other', summary: `Fixture file: ${basename}` };
};
