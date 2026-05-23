/**
 * End-to-end integration test for ContextLoom v1.
 *
 * Requires Docker. Starts an ephemeral PostgreSQL+pgvector container, applies all
 * migrations, ingests fixture files using the fixture extractor (no OpenAI calls),
 * and asserts that the full pipeline (walker → artifact writer → claim writer →
 * entity writer → staleness propagation) produces correct results queryable via
 * the serve-layer query functions.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { readdir, readFile } from 'fs/promises';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

const FIXTURES_DIR = path.join(__dirname, '../fixtures');
const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');
const PROJECT_ID = 'test-project-e2e';

let container: StartedPostgreSqlContainer;
let testPool: Pool;

// References populated by dynamic imports inside `before` (after DATABASE_URL is set)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let modules: {
  runIngest: (config: unknown, configPath: string, extractor: unknown) => Promise<void>;
  searchLexical: (
    pool: Pool,
    query: string,
    entityTypes: string[],
    projectId: string,
    limit: number
  ) => Promise<Array<{ entity: { entity_id: string; entity_type: string; name: string; project_id: string } }>>;
  fetchEntity: (
    pool: Pool,
    entityId: string
  ) => Promise<{ entity_id: string; entity_type: string; name: string; project_id: string } | null>;
  bfsRelatedEntities: (
    pool: Pool,
    rootEntityId: string,
    direction: string,
    relationshipTypes: string[],
    depth: number
  ) => Promise<{ edges: unknown[]; entityIds: string[] }>;
  fixtureExtractor: (filePath: string, content: string) => Promise<unknown>;
};

async function applyMigrations(pool: Pool, dir: string): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    await pool.query(sql);
  }
}

before(
  async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('contextloom_test')
      .withUsername('contextloom')
      .withPassword('contextloom')
      .start();

    const connectionUri = container.getConnectionUri();

    // Set DATABASE_URL before importing any pool-dependent modules so that
    // db.ts initialises its Pool singleton with the test container URL.
    process.env['DATABASE_URL'] = connectionUri;

    testPool = new Pool({ connectionString: connectionUri });
    await applyMigrations(testPool, MIGRATIONS_DIR);

    // Dynamic imports — must happen after DATABASE_URL is set above
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pipelineMod = await import('../../src/ingest/pipeline');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const queriesMod = await import('../../src/serve/queries');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fixtureMod = await import('../helpers/fixture-extractor');

    modules = {
      runIngest: pipelineMod.runIngest as typeof modules.runIngest,
      searchLexical: queriesMod.searchLexical as typeof modules.searchLexical,
      fetchEntity: queriesMod.fetchEntity as typeof modules.fetchEntity,
      bfsRelatedEntities: queriesMod.bfsRelatedEntities as typeof modules.bfsRelatedEntities,
      fixtureExtractor: fixtureMod.fixtureExtractor as typeof modules.fixtureExtractor,
    };

    // Ingest fixture files once for the whole suite
    const config = {
      project_id: PROJECT_ID,
      name: 'Integration Test Project',
      sources: [{ type: 'repository', path: FIXTURES_DIR, globs: ['**/*.md'] }],
    };
    // configPath dirname resolves to FIXTURES_DIR, so source.path (absolute) works correctly
    await modules.runIngest(
      config,
      path.join(FIXTURES_DIR, 'fake.yaml'),
      modules.fixtureExtractor
    );
  },
  { timeout: 120_000 }
);

after(async () => {
  await testPool?.end();
  await container?.stop();
});

test(
  'searchLexical returns fixture ADR decision entity',
  { timeout: 30_000 },
  async () => {
    const results = await modules.searchLexical(
      testPool,
      'hybrid transport',
      ['decision'],
      PROJECT_ID,
      10
    );

    assert.ok(results.length > 0, 'searchLexical returned no results for "hybrid transport"');

    const adr = results.find((r) => r.entity.name === 'Use Hybrid MCP Transport');
    assert.ok(adr, 'Expected to find "Use Hybrid MCP Transport" decision entity');
    assert.equal(adr.entity.entity_type, 'decision');
    assert.equal(adr.entity.project_id, PROJECT_ID);
  }
);

test('fetchEntity returns expected name and entity_type', { timeout: 30_000 }, async () => {
  const searchResults = await modules.searchLexical(
    testPool,
    'hybrid transport',
    ['decision'],
    PROJECT_ID,
    1
  );
  const entityId = searchResults[0]?.entity.entity_id;
  assert.ok(entityId, 'Expected at least one search result to fetch');

  const entity = await modules.fetchEntity(testPool, entityId);
  assert.ok(entity, 'fetchEntity returned null');
  assert.equal(entity.name, 'Use Hybrid MCP Transport');
  assert.equal(entity.entity_type, 'decision');
});

test(
  'bfsRelatedEntities returns related component entity',
  { timeout: 30_000 },
  async () => {
    const decisionResults = await modules.searchLexical(
      testPool,
      'hybrid transport',
      ['decision'],
      PROJECT_ID,
      1
    );
    const componentResults = await modules.searchLexical(
      testPool,
      'query layer',
      ['component'],
      PROJECT_ID,
      1
    );

    const decisionId = decisionResults[0]?.entity.entity_id;
    const componentId = componentResults[0]?.entity.entity_id;
    assert.ok(decisionId, 'Expected decision entity to exist after ingest');
    assert.ok(componentId, 'Expected component entity to exist after ingest');

    // Seed a RELATED_TO relationship so BFS has an edge to traverse
    await testPool.query(
      `INSERT INTO relationships (from_entity_id, to_entity_id, relationship_type, review_status)
       VALUES ($1, $2, 'RELATED_TO', 'candidate')`,
      [decisionId, componentId]
    );

    const { edges, entityIds } = await modules.bfsRelatedEntities(
      testPool,
      decisionId,
      'outbound',
      [],
      2
    );

    assert.ok(entityIds.includes(componentId), 'Expected BFS to reach the component entity');
    assert.ok(edges.length > 0, 'Expected BFS to find at least one relationship edge');
  }
);
