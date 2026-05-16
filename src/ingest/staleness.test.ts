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

// Real ingest data shape written by entityWriter for entity attribute claims:
//   CLAIM_DERIVED_FROM:       artifact_version → entity_attr_claim
//   ATTRIBUTE_CONTRIBUTED_BY: entity_attr_claim → entity
// Both links are required; without CLAIM_DERIVED_FROM the BFS never discovers the claim.
test('BFS propagates last_evidence_change_at through entity attribute claim chain', async () => {
  const links: Link[] = [
    // CLAIM_DERIVED_FROM: artifact_version → entity_attr_claim (written by entityWriter)
    {
      source_type: 'artifact_version',
      source_id: 'av-1',
      target_type: 'claim',
      target_id: 'entity-attr-claim-1',
    },
    // ATTRIBUTE_CONTRIBUTED_BY: entity_attr_claim → entity (written by entityWriter)
    {
      source_type: 'claim',
      source_id: 'entity-attr-claim-1',
      target_type: 'entity',
      target_id: 'entity-1',
    },
  ];

  const { client, updated } = makeClient(links);
  await propagateStalenessWith(client, 'av-1');

  assert.ok(
    updated.includes('claim:entity-attr-claim-1'),
    'entity attribute claim should be marked stale'
  );
  assert.ok(updated.includes('entity:entity-1'), 'entity should be marked stale');
});

// Without the CLAIM_DERIVED_FROM link (the pre-fix bug state), entity attr claims
// are not reachable from artifact_version and BFS cannot mark them stale.
test('BFS does not reach entity attribute claims when CLAIM_DERIVED_FROM link is absent', async () => {
  const links: Link[] = [
    // Only ATTRIBUTE_CONTRIBUTED_BY exists — no entry point from artifact_version
    {
      source_type: 'claim',
      source_id: 'entity-attr-claim-1',
      target_type: 'entity',
      target_id: 'entity-1',
    },
  ];

  const { client, updated } = makeClient(links);
  await propagateStalenessWith(client, 'av-1');

  assert.ok(
    !updated.includes('claim:entity-attr-claim-1'),
    'claim should not be reached without CLAIM_DERIVED_FROM link'
  );
  assert.ok(
    !updated.includes('entity:entity-1'),
    'entity should not be reached without CLAIM_DERIVED_FROM link'
  );
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
