import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../logger';
import type { TrustFilterConfig } from './types';
import { passesFilter, applyFilter } from './trust-filter';
import {
  fetchEntity,
  fetchEntityClaims,
  fetchArtifactRefs,
  fetchEntitiesByType,
  fetchProjectEntity,
  fetchArtifact,
  fetchArtifactVersion,
  fetchArtifactClaims,
  embedQuery,
  searchLexical,
  searchSemantic,
  bfsRelatedEntities,
  fetchEntitiesByIds,
  fetchStalenessCount,
} from './queries';

function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function mergeFilter(
  serverFilter: TrustFilterConfig,
  req?: {
    allow_review_statuses?: string[];
    include_conflicted?: boolean;
    max_staleness_days?: number | null;
  }
): TrustFilterConfig {
  if (!req) return serverFilter;
  return {
    allow_review_statuses: req.allow_review_statuses ?? serverFilter.allow_review_statuses,
    include_conflicted: req.include_conflicted ?? serverFilter.include_conflicted,
    max_staleness_days:
      req.max_staleness_days !== undefined
        ? req.max_staleness_days
        : serverFilter.max_staleness_days,
  };
}

const trustFilterInputSchema = z
  .object({
    allow_review_statuses: z.array(z.string()).optional(),
    include_conflicted: z.boolean().optional(),
    max_staleness_days: z.union([z.number(), z.null()]).optional(),
  })
  .optional()
  .describe('Per-request trust filter; merges on top of server config (request fields override)');

export async function startServer(trustFilter: TrustFilterConfig): Promise<void> {
  const pool = new Pool({
    connectionString:
      process.env['DATABASE_URL'] ??
      'postgresql://contextloom:contextloom@localhost:5432/contextloom',
  });

  const server = new McpServer(
    { name: 'contextloom', version: '0.1.0' },
    { instructions: 'ContextLoom MCP server for AI worker access to project knowledge.' }
  );

  server.registerTool(
    'get_entity',
    {
      description:
        'Get an entity by ID with its claims and optional artifact citations. Trust filter is applied.',
      inputSchema: {
        entity_id: z.string().describe('The entity UUID'),
        include_claims: z
          .boolean()
          .optional()
          .describe('Include EntityClaim[] in the response (default: true)'),
        include_citations: z
          .boolean()
          .optional()
          .describe('Include ArtifactRef[] in the response (default: false)'),
      },
    },
    async ({ entity_id, include_claims, include_citations }) => {
      const requestId = uuidv4();
      const log = logger.child({ request_id: requestId, tool: 'get_entity' });
      log.info({ entity_id }, 'tool invoked');

      const includeClaims = include_claims ?? true;
      const includeCitations = include_citations ?? false;

      const entity = await fetchEntity(pool, entity_id);
      if (!entity) return textResult({ error: 'Entity not found' });
      if (!passesFilter(entity, trustFilter))
        return textResult({ error: 'Entity excluded by trust filter' });

      const response: Record<string, unknown> = { entity };
      if (includeClaims) response['claims'] = await fetchEntityClaims(pool, entity_id);
      if (includeCitations) response['citations'] = await fetchArtifactRefs(pool, entity_id);

      return textResult(response);
    }
  );

  server.registerTool(
    'get_artifact',
    {
      description:
        'Get an artifact by ID with its version content and claims. Defaults to the latest version.',
      inputSchema: {
        artifact_id: z.string().describe('The artifact UUID'),
        artifact_version_id: z
          .string()
          .optional()
          .describe('Specific version UUID; defaults to latest by ingested_at'),
      },
    },
    async ({ artifact_id, artifact_version_id }) => {
      const requestId = uuidv4();
      const log = logger.child({ request_id: requestId, tool: 'get_artifact' });
      log.info({ artifact_id }, 'tool invoked');

      const artifact = await fetchArtifact(pool, artifact_id);
      if (!artifact) return textResult({ error: 'Artifact not found' });

      const artifactVersion = await fetchArtifactVersion(
        pool,
        artifact_id,
        artifact_version_id ?? null
      );
      if (!artifactVersion) return textResult({ error: 'Artifact version not found' });

      const claims = await fetchArtifactClaims(pool, artifactVersion.artifact_version_id);
      return textResult({ envelope: { artifact, artifact_version: artifactVersion }, claims });
    }
  );

  server.registerTool(
    'search_context',
    {
      description:
        'Search entities by lexical (tsvector GIN) and semantic (pgvector cosine) similarity. Returns ranked SearchResult[].',
      inputSchema: {
        query: z.string().describe('Search query text'),
        entity_types: z
          .array(z.string())
          .optional()
          .describe('Filter by entity types (e.g. ["component", "decision"])'),
        project_id: z.string().optional().describe('Filter by project ID'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Maximum results (1-50, default 10)'),
        trust_filter: trustFilterInputSchema,
      },
    },
    async ({ query, entity_types, project_id, limit, trust_filter }) => {
      const requestId = uuidv4();
      const log = logger.child({ request_id: requestId, tool: 'search_context' });
      log.info({ project_id, entity_types, limit }, 'tool invoked');

      const effectiveLimit = limit ?? 10;
      const entityTypes = entity_types ?? [];
      const projectId = project_id ?? null;
      const effectiveFilter = mergeFilter(trustFilter, trust_filter);

      const lexicalResults = await searchLexical(
        pool,
        query,
        entityTypes,
        projectId,
        effectiveLimit * 2
      );

      let semanticResults: Awaited<ReturnType<typeof searchSemantic>> = [];
      try {
        const embedding = await embedQuery(query);
        semanticResults = await searchSemantic(
          pool,
          embedding,
          entityTypes,
          projectId,
          effectiveLimit * 2
        );
      } catch (err) {
        log.debug({ err }, 'semantic search unavailable, degrading to lexical only');
      }

      const scoreMap = new Map<
        string,
        { entity: (typeof lexicalResults)[0]['entity']; score: number }
      >();
      for (const r of [...lexicalResults, ...semanticResults]) {
        const existing = scoreMap.get(r.entity.entity_id);
        if (!existing || r.score > existing.score) {
          scoreMap.set(r.entity.entity_id, r);
        }
      }

      const merged = [...scoreMap.values()]
        .sort((a, b) => b.score - a.score)
        .filter((r) => passesFilter(r.entity, effectiveFilter))
        .slice(0, effectiveLimit);

      const results = await Promise.all(
        merged.map(async ({ entity, score }) => {
          const [matched_entity_claims, citations] = await Promise.all([
            fetchEntityClaims(pool, entity.entity_id),
            fetchArtifactRefs(pool, entity.entity_id),
          ]);
          return { entity, score, matched_entity_claims, citations };
        })
      );

      return textResult(results);
    }
  );

  server.registerTool(
    'get_related_entities',
    {
      description:
        'BFS graph traversal via relationships table up to depth 3. Returns root entity, edges, and related entities with trust filter applied.',
      inputSchema: {
        entity_id: z.string().describe('Root entity UUID'),
        relationship_types: z
          .array(z.string())
          .optional()
          .describe('Filter by relationship types (e.g. ["CONTAINS", "DEPENDS_ON"])'),
        direction: z
          .enum(['outbound', 'inbound', 'both'] as const)
          .optional()
          .describe('Edge direction relative to root entity (default: both)'),
        depth: z.number().int().min(1).max(3).optional().describe('BFS depth 1-3 (default: 1)'),
        trust_filter: trustFilterInputSchema,
      },
    },
    async ({ entity_id, relationship_types, direction, depth, trust_filter }) => {
      const requestId = uuidv4();
      const log = logger.child({ request_id: requestId, tool: 'get_related_entities' });
      log.info({ entity_id, direction, depth }, 'tool invoked');

      const dir = direction ?? 'both';
      const effectiveDepth = depth ?? 1;
      const relTypes = relationship_types ?? [];
      const effectiveFilter = mergeFilter(trustFilter, trust_filter);

      const rootEntity = await fetchEntity(pool, entity_id);
      if (!rootEntity) return textResult({ error: 'Entity not found' });

      const { edges, entityIds } = await bfsRelatedEntities(
        pool,
        entity_id,
        dir,
        relTypes,
        effectiveDepth
      );

      const relatedEntities = applyFilter(
        await fetchEntitiesByIds(pool, entityIds),
        effectiveFilter
      );

      const allowedIds = new Set(relatedEntities.map((e) => e.entity_id));
      allowedIds.add(entity_id);
      const filteredEdges = edges.filter(
        (e) => allowedIds.has(e.from_entity_id) && allowedIds.has(e.to_entity_id)
      );

      return textResult({
        root_entity: rootEntity,
        edges: filteredEdges,
        related_entities: relatedEntities,
      });
    }
  );

  server.registerTool(
    'get_project_overview',
    {
      description:
        'Get project entity, components, decisions, constraints, and staleness summary for a project.',
      inputSchema: {
        project_id: z.string().describe('The project UUID'),
      },
    },
    async ({ project_id }) => {
      const requestId = uuidv4();
      const log = logger.child({ request_id: requestId, tool: 'get_project_overview' });
      log.info({ project_id }, 'tool invoked');

      const projectEntity = await fetchProjectEntity(pool, project_id);
      if (!projectEntity) return textResult({ error: 'Project not found' });
      if (!passesFilter(projectEntity, trustFilter))
        return textResult({ error: 'Project excluded by trust filter' });

      const [components, decisions, constraints, staleCount] = await Promise.all([
        fetchEntitiesByType(pool, project_id, 'component'),
        fetchEntitiesByType(pool, project_id, 'decision'),
        fetchEntitiesByType(pool, project_id, 'constraint'),
        fetchStalenessCount(pool, project_id),
      ]);

      return textResult({
        project: projectEntity,
        components: applyFilter(components, trustFilter),
        decisions: applyFilter(decisions, trustFilter),
        constraints: applyFilter(constraints, trustFilter),
        staleness: { stale_count: staleCount },
      });
    }
  );

  server.resource(
    'project',
    new ResourceTemplate('context://projects/{project_id}', { list: undefined }),
    async (_uri, variables) => {
      const projectId = String(variables['project_id'] ?? '');
      const entity = await fetchProjectEntity(pool, projectId);
      const filtered = entity && passesFilter(entity, trustFilter) ? entity : null;
      return {
        contents: [
          {
            uri: `context://projects/${projectId}`,
            mimeType: 'application/json',
            text: JSON.stringify(filtered),
          },
        ],
      };
    }
  );

  server.resource(
    'project-components',
    new ResourceTemplate('context://projects/{project_id}/components', { list: undefined }),
    async (_uri, variables) => {
      const projectId = String(variables['project_id'] ?? '');
      const entities = await fetchEntitiesByType(pool, projectId, 'component');
      return {
        contents: [
          {
            uri: `context://projects/${projectId}/components`,
            mimeType: 'application/json',
            text: JSON.stringify(applyFilter(entities, trustFilter)),
          },
        ],
      };
    }
  );

  server.resource(
    'project-decisions',
    new ResourceTemplate('context://projects/{project_id}/decisions', { list: undefined }),
    async (_uri, variables) => {
      const projectId = String(variables['project_id'] ?? '');
      const entities = await fetchEntitiesByType(pool, projectId, 'decision');
      return {
        contents: [
          {
            uri: `context://projects/${projectId}/decisions`,
            mimeType: 'application/json',
            text: JSON.stringify(applyFilter(entities, trustFilter)),
          },
        ],
      };
    }
  );

  server.resource(
    'entity',
    new ResourceTemplate('context://entities/{entity_id}', { list: undefined }),
    async (_uri, variables) => {
      const entityId = String(variables['entity_id'] ?? '');
      const entity = await fetchEntity(pool, entityId);
      const filtered = entity && passesFilter(entity, trustFilter) ? entity : null;
      return {
        contents: [
          {
            uri: `context://entities/${entityId}`,
            mimeType: 'application/json',
            text: JSON.stringify(filtered),
          },
        ],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
