import type { Pool } from 'pg';
import type {
  Entity,
  EntityClaim,
  ArtifactRef,
  Artifact,
  ArtifactVersion,
  ArtifactClaim,
} from './types';

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
