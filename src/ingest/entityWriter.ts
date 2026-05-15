import { PoolClient } from 'pg';
import pool from '../db';
import { EntityExtraction } from './extractor';

export async function writeEntities(
  projectId: string,
  entities: EntityExtraction[]
): Promise<void> {
  if (entities.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const entity of entities) {
      await insertEntity(client, projectId, entity);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertEntity(
  client: PoolClient,
  projectId: string,
  entity: EntityExtraction
): Promise<void> {
  const { rows } = await client.query<{ entity_id: string }>(
    `INSERT INTO entities (project_id, entity_type, name, description, review_status)
     VALUES ($1, $2, $3, $4, 'candidate')
     RETURNING entity_id`,
    [projectId, entity.entity_type, entity.name, entity.description]
  );

  const entityId = rows[0]?.entity_id;
  if (!entityId) return;

  for (const { key, value } of entity.attributes) {
    await insertEntityClaimWithDerivation(client, entityId, key, value);
  }
}

async function insertEntityClaimWithDerivation(
  client: PoolClient,
  entityId: string,
  claimType: string,
  value: string
): Promise<void> {
  const { rows } = await client.query<{ claim_id: string }>(
    `INSERT INTO claims (subject_type, subject_id, claim_type, value, review_status)
     VALUES ('entity', $1, $2, $3, 'candidate')
     RETURNING claim_id`,
    [entityId, claimType, JSON.stringify({ value })]
  );

  const claimId = rows[0]?.claim_id;
  if (!claimId) return;

  await client.query(
    `INSERT INTO derivation_links (link_type, source_type, source_id, target_type, target_id)
     VALUES ('ATTRIBUTE_CONTRIBUTED_BY', 'claim', $1, 'entity', $2)`,
    [claimId, entityId]
  );
}
