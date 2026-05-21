import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { Pool } from 'pg';
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
} from './queries';

function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

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
