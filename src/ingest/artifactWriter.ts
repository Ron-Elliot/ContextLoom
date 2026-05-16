import pool from '../db';
import { Envelope } from './envelope';

export async function writeArtifact(
  projectId: string,
  sourceType: string,
  envelope: Envelope
): Promise<{ changed: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO artifacts (artifact_id, project_id, source_type, source_uri)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, source_type, source_uri) DO NOTHING`,
      [envelope.artifact_id, projectId, sourceType, envelope.source_uri]
    );

    const { rows } = await client.query<{ content_hash: string }>(
      `SELECT content_hash FROM artifact_versions
       WHERE artifact_id = $1
       ORDER BY ingested_at DESC
       LIMIT 1`,
      [envelope.artifact_id]
    );

    const previousHash = rows[0]?.content_hash ?? null;
    const changed = previousHash !== envelope.content_hash;

    await client.query(
      `INSERT INTO artifact_versions
         (artifact_version_id, artifact_id, content_hash, content, provenance,
          source_modified_at, extractor, envelope_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        envelope.artifact_version_id,
        envelope.artifact_id,
        envelope.content_hash,
        envelope.content,
        JSON.stringify(envelope.provenance),
        envelope.source_modified_at,
        envelope.extractor,
        envelope.envelope_version,
      ]
    );

    await client.query('COMMIT');
    return { changed };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
