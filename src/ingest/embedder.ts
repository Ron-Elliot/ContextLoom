import OpenAI from 'openai';
import pool from '../db';

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

export async function embedEntities(entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;

  const openai = getClient();
  const client = await pool.connect();
  try {
    for (const entityId of entityIds) {
      const entityRes = await client.query<{ name: string; description: string | null }>(
        'SELECT name, description FROM entities WHERE entity_id = $1',
        [entityId]
      );
      if (entityRes.rows.length === 0) continue;

      const { name, description } = entityRes.rows[0];

      const claimsRes = await client.query<{ claim_type: string; value: Record<string, unknown> }>(
        "SELECT claim_type, value FROM claims WHERE subject_type = 'entity' AND subject_id = $1",
        [entityId]
      );

      const parts: string[] = [`Name: ${name}`];
      if (description) parts.push(`Description: ${description}`);
      for (const row of claimsRes.rows) {
        const val = row.value as Record<string, unknown>;
        const text = typeof val['value'] === 'string' ? val['value'] : JSON.stringify(val);
        parts.push(`${row.claim_type}: ${text}`);
      }

      const embeddingRes = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: parts.join('\n'),
        dimensions: 1536,
      });

      const vector = embeddingRes.data[0]?.embedding;
      if (!vector) continue;

      await client.query('UPDATE entities SET embedding = $1::vector WHERE entity_id = $2', [
        `[${vector.join(',')}]`,
        entityId,
      ]);
    }
  } finally {
    client.release();
  }
}
