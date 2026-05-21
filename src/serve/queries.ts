import type { Pool } from 'pg';
import OpenAI from 'openai';
import type {
  Entity,
  EntityClaim,
  ArtifactRef,
  Artifact,
  ArtifactVersion,
  ArtifactClaim,
  RelationshipEdge,
} from './types';

let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!_openai) {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    _openai = new OpenAI({ apiKey });
  }
  return _openai;
}

export async function embedQuery(queryText: string): Promise<number[]> {
  const openai = getOpenAI();
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: queryText,
    dimensions: 1536,
  });
  const embedding = res.data[0]?.embedding;
  if (!embedding) throw new Error('Failed to get embedding from OpenAI');
  return embedding;
}

export async function fetchEntity(pool: Pool, entityId: string): Promise<Entity | null> {
  const result = await pool.query<Entity>(
    `SELECT entity_id, project_id, entity_type, name, description,
            review_status, attention_state,
            last_verified_at, last_evidence_change_at,
            metadata, created_at, updated_at
     FROM entities WHERE entity_id = $1`,
    [entityId]
  );
  return result.rows[0] ?? null;
}

export async function fetchEntityClaims(pool: Pool, entityId: string): Promise<EntityClaim[]> {
  const result = await pool.query<EntityClaim>(
    `SELECT claim_id, subject_type, subject_id, claim_type, value,
            review_status, last_verified_at, last_evidence_change_at,
            metadata, created_at, updated_at
     FROM claims
     WHERE subject_type = 'entity' AND subject_id = $1`,
    [entityId]
  );
  return result.rows;
}

export async function fetchArtifactRefs(pool: Pool, entityId: string): Promise<ArtifactRef[]> {
  // Traverse: entity ← ATTRIBUTE_CONTRIBUTED_BY ← claim ← CLAIM_DERIVED_FROM ← artifact_version → artifact
  const result = await pool.query<ArtifactRef>(
    `SELECT DISTINCT a.artifact_id, a.source_uri
     FROM derivation_links attr_link
     JOIN derivation_links claim_link
       ON claim_link.link_type = 'CLAIM_DERIVED_FROM'
      AND claim_link.target_type = 'claim'
      AND claim_link.target_id = attr_link.source_id
      AND attr_link.source_type = 'claim'
     JOIN artifact_versions av
       ON av.artifact_version_id = claim_link.source_id
      AND claim_link.source_type = 'artifact_version'
     JOIN artifacts a ON a.artifact_id = av.artifact_id
     WHERE attr_link.link_type = 'ATTRIBUTE_CONTRIBUTED_BY'
       AND attr_link.target_type = 'entity'
       AND attr_link.target_id = $1`,
    [entityId]
  );
  return result.rows;
}

export async function fetchEntitiesByType(
  pool: Pool,
  projectId: string,
  entityType: string
): Promise<Entity[]> {
  const result = await pool.query<Entity>(
    `SELECT entity_id, project_id, entity_type, name, description,
            review_status, attention_state,
            last_verified_at, last_evidence_change_at,
            metadata, created_at, updated_at
     FROM entities
     WHERE project_id = $1 AND entity_type = $2`,
    [projectId, entityType]
  );
  return result.rows;
}

export async function fetchProjectEntity(pool: Pool, projectId: string): Promise<Entity | null> {
  const result = await pool.query<Entity>(
    `SELECT entity_id, project_id, entity_type, name, description,
            review_status, attention_state,
            last_verified_at, last_evidence_change_at,
            metadata, created_at, updated_at
     FROM entities
     WHERE project_id = $1 AND entity_type = 'project'
     LIMIT 1`,
    [projectId]
  );
  return result.rows[0] ?? null;
}

export async function fetchArtifact(pool: Pool, artifactId: string): Promise<Artifact | null> {
  const result = await pool.query<Artifact>(
    `SELECT artifact_id, project_id, source_type, source_uri, created_at
     FROM artifacts WHERE artifact_id = $1`,
    [artifactId]
  );
  return result.rows[0] ?? null;
}

export async function fetchArtifactVersion(
  pool: Pool,
  artifactId: string,
  artifactVersionId: string | null
): Promise<ArtifactVersion | null> {
  if (artifactVersionId) {
    const result = await pool.query<ArtifactVersion>(
      `SELECT artifact_version_id, artifact_id, content_hash, content, content_ref,
              provenance, source_modified_at, extractor, tags, envelope_version, ingested_at
       FROM artifact_versions
       WHERE artifact_version_id = $1 AND artifact_id = $2`,
      [artifactVersionId, artifactId]
    );
    return result.rows[0] ?? null;
  }

  const result = await pool.query<ArtifactVersion>(
    `SELECT artifact_version_id, artifact_id, content_hash, content, content_ref,
            provenance, source_modified_at, extractor, tags, envelope_version, ingested_at
     FROM artifact_versions
     WHERE artifact_id = $1
     ORDER BY ingested_at DESC
     LIMIT 1`,
    [artifactId]
  );
  return result.rows[0] ?? null;
}

export async function fetchArtifactClaims(
  pool: Pool,
  artifactVersionId: string
): Promise<ArtifactClaim[]> {
  // Filter through derivation_links so only claims derived from this specific
  // artifact_version are returned, not claims from other versions of the same artifact.
  const result = await pool.query<ArtifactClaim>(
    `SELECT c.claim_id, c.subject_type, c.subject_id, c.claim_type, c.value,
            c.review_status, c.last_verified_at, c.last_evidence_change_at,
            c.metadata, c.created_at, c.updated_at
     FROM claims c
     JOIN derivation_links dl
       ON dl.link_type = 'CLAIM_DERIVED_FROM'
      AND dl.source_type = 'artifact_version'
      AND dl.source_id = $1
      AND dl.target_type = 'claim'
      AND dl.target_id = c.claim_id
     WHERE c.subject_type = 'artifact'`,
    [artifactVersionId]
  );
  return result.rows;
}

type EntityWithScore = Entity & { score: number };

export async function searchLexical(
  pool: Pool,
  query: string,
  entityTypes: string[],
  projectId: string | null,
  limit: number
): Promise<Array<{ entity: Entity; score: number }>> {
  const params: unknown[] = [query];
  const conditions: string[] = ["search_vector @@ plainto_tsquery('english', $1)"];

  if (entityTypes.length > 0) {
    params.push(entityTypes);
    conditions.push(`entity_type = ANY($${params.length}::text[])`);
  }

  if (projectId) {
    params.push(projectId);
    conditions.push(`project_id = $${params.length}`);
  }

  params.push(limit);

  const sql = `
    SELECT entity_id, project_id, entity_type, name, description,
           review_status, attention_state,
           last_verified_at, last_evidence_change_at,
           metadata, created_at, updated_at,
           ts_rank(search_vector, plainto_tsquery('english', $1)) AS score
    FROM entities
    WHERE ${conditions.join(' AND ')}
    ORDER BY score DESC
    LIMIT $${params.length}
  `;

  const result = await pool.query<EntityWithScore>(sql, params);
  return result.rows.map(({ score, ...entity }) => ({ entity, score: Number(score) }));
}

export async function searchSemantic(
  pool: Pool,
  embedding: number[],
  entityTypes: string[],
  projectId: string | null,
  limit: number
): Promise<Array<{ entity: Entity; score: number }>> {
  const vectorStr = `[${embedding.join(',')}]`;
  const params: unknown[] = [vectorStr];
  const conditions: string[] = ['embedding IS NOT NULL'];

  if (entityTypes.length > 0) {
    params.push(entityTypes);
    conditions.push(`entity_type = ANY($${params.length}::text[])`);
  }

  if (projectId) {
    params.push(projectId);
    conditions.push(`project_id = $${params.length}`);
  }

  params.push(limit);

  const sql = `
    SELECT entity_id, project_id, entity_type, name, description,
           review_status, attention_state,
           last_verified_at, last_evidence_change_at,
           metadata, created_at, updated_at,
           1 - (embedding <=> $1::vector) AS score
    FROM entities
    WHERE ${conditions.join(' AND ')}
    ORDER BY embedding <=> $1::vector
    LIMIT $${params.length}
  `;

  const result = await pool.query<EntityWithScore>(sql, params);
  return result.rows.map(({ score, ...entity }) => ({ entity, score: Number(score) }));
}

async function fetchRelationshipEdges(
  pool: Pool,
  frontierIds: string[],
  direction: 'outbound' | 'inbound' | 'both',
  relationshipTypes: string[]
): Promise<RelationshipEdge[]> {
  if (frontierIds.length === 0) return [];

  const params: unknown[] = [frontierIds];
  const conditions: string[] = [];

  if (direction === 'outbound') {
    conditions.push('from_entity_id = ANY($1::uuid[])');
  } else if (direction === 'inbound') {
    conditions.push('to_entity_id = ANY($1::uuid[])');
  } else {
    conditions.push('(from_entity_id = ANY($1::uuid[]) OR to_entity_id = ANY($1::uuid[]))');
  }

  if (relationshipTypes.length > 0) {
    params.push(relationshipTypes);
    conditions.push(`relationship_type = ANY($${params.length}::text[])`);
  }

  const result = await pool.query<RelationshipEdge>(
    `SELECT relationship_id, from_entity_id, to_entity_id, relationship_type,
            review_status, attention_state,
            last_verified_at, last_evidence_change_at,
            metadata, created_at, updated_at
     FROM relationships
     WHERE ${conditions.join(' AND ')}`,
    params
  );
  return result.rows;
}

export async function bfsRelatedEntities(
  pool: Pool,
  rootEntityId: string,
  direction: 'outbound' | 'inbound' | 'both',
  relationshipTypes: string[],
  depth: number
): Promise<{ edges: RelationshipEdge[]; entityIds: string[] }> {
  const visited = new Set<string>([rootEntityId]);
  const allEdges: RelationshipEdge[] = [];
  const seenEdgeIds = new Set<string>();
  const relatedEntityIds: string[] = [];
  let frontier = [rootEntityId];

  for (let d = 0; d < depth; d++) {
    if (frontier.length === 0) break;
    const edges = await fetchRelationshipEdges(pool, frontier, direction, relationshipTypes);
    const nextFrontier: string[] = [];

    for (const edge of edges) {
      if (seenEdgeIds.has(edge.relationship_id)) continue;
      seenEdgeIds.add(edge.relationship_id);
      allEdges.push(edge);

      const candidates: string[] = [];
      if (direction === 'outbound' || direction === 'both') candidates.push(edge.to_entity_id);
      if (direction === 'inbound' || direction === 'both') candidates.push(edge.from_entity_id);

      for (const neighborId of candidates) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          nextFrontier.push(neighborId);
          relatedEntityIds.push(neighborId);
        }
      }
    }

    frontier = nextFrontier;
  }

  return { edges: allEdges, entityIds: relatedEntityIds };
}

export async function fetchEntitiesByIds(pool: Pool, entityIds: string[]): Promise<Entity[]> {
  if (entityIds.length === 0) return [];
  const result = await pool.query<Entity>(
    `SELECT entity_id, project_id, entity_type, name, description,
            review_status, attention_state,
            last_verified_at, last_evidence_change_at,
            metadata, created_at, updated_at
     FROM entities WHERE entity_id = ANY($1::uuid[])`,
    [entityIds]
  );
  return result.rows;
}

export async function fetchStalenessCount(pool: Pool, projectId: string): Promise<number> {
  const result = await pool.query<{ stale_count: string }>(
    `SELECT COUNT(*)::int AS stale_count
     FROM entities
     WHERE project_id = $1
       AND last_evidence_change_at IS NOT NULL
       AND (last_verified_at IS NULL OR last_evidence_change_at > last_verified_at)`,
    [projectId]
  );
  return Number(result.rows[0]?.stale_count ?? 0);
}
