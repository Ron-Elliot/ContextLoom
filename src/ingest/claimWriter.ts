import { PoolClient } from 'pg';
import pool from '../db';
import { ExtractionResult } from './extractor';

export async function writeClaims(
  artifactId: string,
  artifactVersionId: string,
  result: ExtractionResult
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await writeArtifactClaims(client, artifactId, artifactVersionId, result);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertClaimWithDerivation(
  client: PoolClient,
  artifactId: string,
  artifactVersionId: string,
  claimType: string,
  value: Record<string, unknown>
): Promise<void> {
  const { rows } = await client.query<{ claim_id: string }>(
    `INSERT INTO claims (subject_type, subject_id, claim_type, value)
     VALUES ('artifact', $1, $2, $3)
     RETURNING claim_id`,
    [artifactId, claimType, JSON.stringify(value)]
  );
  const claimId = rows[0]?.claim_id;
  if (!claimId) return;

  await client.query(
    `INSERT INTO derivation_links (link_type, source_type, source_id, target_type, target_id)
     VALUES ('CLAIM_DERIVED_FROM', 'artifact_version', $1, 'claim', $2)`,
    [artifactVersionId, claimId]
  );
}

async function writeArtifactClaims(
  client: PoolClient,
  artifactId: string,
  artifactVersionId: string,
  result: ExtractionResult
): Promise<void> {
  await insertClaimWithDerivation(client, artifactId, artifactVersionId, 'summary', {
    text: result.summary,
  });

  if (result.imports) {
    for (const module of result.imports) {
      await insertClaimWithDerivation(client, artifactId, artifactVersionId, 'import', {
        module,
      });
    }
  }

  if (result.exports) {
    for (const symbol of result.exports) {
      await insertClaimWithDerivation(client, artifactId, artifactVersionId, 'export_symbol', {
        symbol,
      });
    }
  }

  if (result.keyValues) {
    for (const { key, value } of result.keyValues) {
      await insertClaimWithDerivation(client, artifactId, artifactVersionId, 'config_key_value', {
        key,
        value,
      });
    }
  }

  if (result.assertions) {
    for (const assertion of result.assertions) {
      await insertClaimWithDerivation(
        client,
        artifactId,
        artifactVersionId,
        'behavioral_assertion',
        { assertion }
      );
    }
  }
}
