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
      await upsertEntity(client, projectId, entity);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function upsertEntity(
  client: PoolClient,
  projectId: string,
  entity: EntityExtraction
): Promise<void> {
  const { rows } = await client.query<{ entity_id: string }>(
    `INSERT INTO entities (project_id, entity_type, name, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, entity_type, name) DO UPDATE
       SET description = EXCLUDED.description,
           updated_at = now()
     RETURNING entity_id`,
    [projectId, entity.entity_type, entity.name, entity.description]
  );

  const entityId = rows[0]?.entity_id;
  if (!entityId) return;

  for (const { key, value } of entity.attributes) {
    await insertEntityAttributeWithDerivation(client, entityId, key, value);
  }
}

async function insertEntityAttributeWithDerivation(
  client: PoolClient,
  entityId: string,
  key: string,
  value: string
): Promise<void> {
  const { rows } = await client.query<{ claim_id: string }>(
    `INSERT INTO claims (subject_type, subject_id, claim_type, value)
     VALUES ('entity', $1, 'attribute', $2)
     RETURNING claim_id`,
    [entityId, JSON.stringify({ key, value })]
  );

  const claimId = rows[0]?.claim_id;
  if (!claimId) return;

  await client.query(
    `INSERT INTO derivation_links (link_type, source_type, source_id, target_type, target_id)
     VALUES ('ATTRIBUTE_CONTRIBUTED_BY', 'claim', $1, 'entity', $2)`,
    [claimId, entityId]
  );
}
