import pool from '../db';

// Cosine distance threshold for pgvector <=> operator (1 - cosine_similarity).
// 0.15 corresponds to cosine similarity >= 0.85.
const EMBEDDING_SIMILARITY_THRESHOLD = 0.15;

export async function reconcileEntities(projectId: string, entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const entityId of entityIds) {
      const entityRes = await client.query<{
        entity_type: string;
        name: string;
        embedding: string | null;
      }>('SELECT entity_type, name, embedding FROM entities WHERE entity_id = $1', [entityId]);
      if (entityRes.rows.length === 0) continue;

      const { entity_type, name, embedding } = entityRes.rows[0];

      // Collect candidate duplicate IDs from both signals into a deduplicated set.
      // Both signals query project-wide, so cross-run duplicates (entity from a previous
      // run matching an entity from the current run) are detected here.
      const candidateIds = new Set<string>();

      // Signal 1: exact (entity_type, name) match within the same project
      const nameMatchRes = await client.query<{ entity_id: string }>(
        `SELECT entity_id FROM entities
         WHERE project_id = $1 AND entity_type = $2 AND name = $3 AND entity_id != $4`,
        [projectId, entity_type, name, entityId]
      );
      for (const { entity_id } of nameMatchRes.rows) {
        candidateIds.add(entity_id);
      }

      // Signal 2: embedding cosine similarity (requires embedder to have run first)
      if (embedding) {
        const embeddingMatchRes = await client.query<{ entity_id: string }>(
          `SELECT entity_id FROM entities
           WHERE project_id = $1
             AND entity_type = $2
             AND entity_id != $3
             AND embedding IS NOT NULL
             AND (embedding <=> $4::vector) <= $5`,
          [projectId, entity_type, entityId, embedding, EMBEDDING_SIMILARITY_THRESHOLD]
        );
        for (const { entity_id } of embeddingMatchRes.rows) {
          candidateIds.add(entity_id);
        }
      }

      for (const otherId of candidateIds) {
        // Skip if a POSSIBLE_DUPLICATE_OF already exists in either direction
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
