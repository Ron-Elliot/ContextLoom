import { PoolClient } from 'pg';
import pool from '../db';

export async function propagateStaleness(artifactVersionId: string): Promise<void> {
  const now = new Date();
  const client = await pool.connect();
  try {
    // BFS: traverse outgoing derivation links from the changed artifact version
    const discovered = new Set<string>();
    const queue: Array<{ type: string; id: string }> = [
      { type: 'artifact_version', id: artifactVersionId },
    ];
    discovered.add(`artifact_version:${artifactVersionId}`);

    while (queue.length > 0) {
      const current = queue.shift()!;

      const { rows: links } = await client.query<{ target_type: string; target_id: string }>(
        'SELECT target_type, target_id FROM derivation_links WHERE source_type = $1 AND source_id = $2',
        [current.type, current.id]
      );

      for (const { target_type, target_id } of links) {
        const key = `${target_type}:${target_id}`;
        if (discovered.has(key)) continue;
        discovered.add(key);

        if (await isAlreadyVerified(client, target_type, target_id)) continue;

        await setLastEvidenceChangeAt(client, target_type, target_id, now);
        queue.push({ type: target_type, id: target_id });
      }
    }
  } finally {
    client.release();
  }
}

async function isAlreadyVerified(client: PoolClient, type: string, id: string): Promise<boolean> {
  let query: string;
  if (type === 'claim') {
    query = `SELECT 1 FROM claims
             WHERE claim_id = $1
               AND last_verified_at IS NOT NULL
               AND last_verified_at >= last_evidence_change_at`;
  } else if (type === 'entity') {
    query = `SELECT 1 FROM entities
             WHERE entity_id = $1
               AND last_verified_at IS NOT NULL
               AND last_verified_at >= last_evidence_change_at`;
  } else {
    return false;
  }
  const { rows } = await client.query(query, [id]);
  return rows.length > 0;
}

async function setLastEvidenceChangeAt(
  client: PoolClient,
  type: string,
  id: string,
  now: Date
): Promise<void> {
  if (type === 'claim') {
    await client.query('UPDATE claims SET last_evidence_change_at = $1 WHERE claim_id = $2', [
      now,
      id,
    ]);
  } else if (type === 'entity') {
    await client.query('UPDATE entities SET last_evidence_change_at = $1 WHERE entity_id = $2', [
      now,
      id,
    ]);
  }
}
