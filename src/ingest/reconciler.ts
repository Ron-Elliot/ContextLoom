import pool from '../db';

export async function reconcileEntities(projectId: string, entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const entityId of entityIds) {
      const entityRes = await client.query<{ entity_type: string; name: string }>(
        'SELECT entity_type, name FROM entities WHERE entity_id = $1',
        [entityId]
      );
      if (entityRes.rows.length === 0) continue;

      const { entity_type, name } = entityRes.rows[0];

      // Find other entities in the same project with the same (entity_type, name)
      const duplicatesRes = await client.query<{ entity_id: string }>(
        `SELECT entity_id FROM entities
         WHERE project_id = $1 AND entity_type = $2 AND name = $3 AND entity_id != $4`,
        [projectId, entity_type, name, entityId]
      );

      for (const { entity_id: otherId } of duplicatesRes.rows) {
        // Check if relationship already exists in either direction
        const existingRes = await client.query<{ relationship_id: string }>(
          `SELECT relationship_id FROM relationships
           WHERE relationship_type = 'POSSIBLE_DUPLICATE_OF'
             AND ((from_entity_id = $1 AND to_entity_id = $2)
               OR (from_entity_id = $2 AND to_entity_id = $1))`,
          [entityId, otherId]
        );
        if (existingRes.rows.length > 0) continue;

        const [fromId, toId] = entityId < otherId ? [entityId, otherId] : [otherId, entityId];
        await client.query(
          `INSERT INTO relationships (from_entity_id, to_entity_id, relationship_type, review_status)
           VALUES ($1, $2, 'POSSIBLE_DUPLICATE_OF', 'candidate')`,
          [fromId, toId]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
