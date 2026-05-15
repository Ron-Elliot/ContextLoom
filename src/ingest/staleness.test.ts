import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { propagateStalenessWith } from './staleness';

type Link = { source_type: string; source_id: string; target_type: string; target_id: string };

function makeClient(
  links: Link[],
  verifiedIds: Set<string> = new Set()
): { client: PoolClient; updated: string[] } {
  const updated: string[] = [];

  const client = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('SELECT target_type, target_id FROM derivation_links')) {
        const [st, si] = params as [string, string];
        const rows = links
          .filter((l) => l.source_type === st && l.source_id === si)
          .map((l) => ({ target_type: l.target_type, target_id: l.target_id }));
        return { rows };
      }
      if (sql.includes('SELECT 1 FROM claims') || sql.includes('SELECT 1 FROM entities')) {
        const id = params[0] as string;
        return { rows: verifiedIds.has(id) ? [{}] : [] };
      }
      if (sql.includes('UPDATE claims SET last_evidence_change_at')) {
        updated.push(`claim:${params[1]}`);
        return { rows: [] };
      }
      if (sql.includes('UPDATE entities SET last_evidence_change_at')) {
        updated.push(`entity:${params[1]}`);
        return { rows: [] };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;

  return { client, updated };
}

test('BFS propagates last_evidence_change_at from artifact_version through claim to entity', async () => {
  const links: Link[] = [
    {
      source_type: 'artifact_version',
      source_id: 'av-1',
      target_type: 'claim',
      target_id: 'claim-1',
    },
    {
      source_type: 'claim',
      source_id: 'claim-1',
      target_type: 'entity',
      target_id: 'entity-1',
    },
  ];

  const { client, updated } = makeClient(links);
  await propagateStalenessWith(client, 'av-1');

  assert.ok(updated.includes('claim:claim-1'), 'claim-1 should be marked stale');
  assert.ok(updated.includes('entity:entity-1'), 'entity-1 should be marked stale');
});

test('BFS stops propagation at already-verified items and does not update downstream', async () => {
  const links: Link[] = [
    {
      source_type: 'artifact_version',
      source_id: 'av-1',
      target_type: 'claim',
      target_id: 'claim-verified',
    },
    {
      source_type: 'claim',
      source_id: 'claim-verified',
      target_type: 'entity',
      target_id: 'entity-1',
    },
  ];

  // claim-verified has last_verified_at >= last_evidence_change_at
  const { client, updated } = makeClient(links, new Set(['claim-verified']));
  await propagateStalenessWith(client, 'av-1');

  assert.ok(!updated.includes('claim:claim-verified'), 'verified claim should not be updated');
  assert.ok(
    !updated.includes('entity:entity-1'),
    'entity downstream of verified claim should not be reached'
  );
});
