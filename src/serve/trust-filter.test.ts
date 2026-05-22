import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passesFilter } from './trust-filter';
import type { Entity, TrustFilterConfig } from './types';

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    entity_id: 'ent-1',
    project_id: 'proj-1',
    entity_type: 'component',
    name: 'Test Entity',
    description: null,
    review_status: 'reviewed',
    attention_state: null,
    last_verified_at: null,
    last_evidence_change_at: null,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

const baseConfig: TrustFilterConfig = {
  allow_review_statuses: ['reviewed'],
  include_conflicted: false,
  max_staleness_days: null,
};

test('passes when entity meets all filter criteria', () => {
  const entity = makeEntity({ review_status: 'reviewed', attention_state: null });
  assert.equal(passesFilter(entity, baseConfig), true);
});

test('excludes entity with review_status not in allow-list', () => {
  const candidate = makeEntity({ review_status: 'candidate' });
  assert.equal(passesFilter(candidate, baseConfig), false);

  const rejected = makeEntity({ review_status: 'rejected' });
  assert.equal(passesFilter(rejected, baseConfig), false);
});

test('allows entity with review_status in custom allow-list', () => {
  const config: TrustFilterConfig = {
    ...baseConfig,
    allow_review_statuses: ['candidate', 'reviewed'],
  };
  const candidate = makeEntity({ review_status: 'candidate' });
  assert.equal(passesFilter(candidate, config), true);
});

test('excludes conflicted entity when include_conflicted is false', () => {
  const entity = makeEntity({ attention_state: 'conflicted' });
  assert.equal(passesFilter(entity, baseConfig), false);
});

test('includes conflicted entity when include_conflicted is true', () => {
  const config: TrustFilterConfig = { ...baseConfig, include_conflicted: true };
  const entity = makeEntity({ attention_state: 'conflicted' });
  assert.equal(passesFilter(entity, config), true);
});

test('excludes stale entity when max_staleness_days is set', () => {
  const config: TrustFilterConfig = { ...baseConfig, max_staleness_days: 7 };
  const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const entity = makeEntity({
    last_evidence_change_at: staleDate,
    last_verified_at: null,
  });
  assert.equal(passesFilter(entity, config), false);
});

test('excludes stale entity when last_verified_at is before last_evidence_change_at and age exceeds threshold', () => {
  const config: TrustFilterConfig = { ...baseConfig, max_staleness_days: 7 };
  const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const olderVerified = new Date(staleDate.getTime() - 1000);
  const entity = makeEntity({
    last_evidence_change_at: staleDate,
    last_verified_at: olderVerified,
  });
  assert.equal(passesFilter(entity, config), false);
});

test('does not exclude entity when last_verified_at is after last_evidence_change_at', () => {
  const config: TrustFilterConfig = { ...baseConfig, max_staleness_days: 7 };
  const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const newerVerified = new Date(staleDate.getTime() + 1000);
  const entity = makeEntity({
    last_evidence_change_at: staleDate,
    last_verified_at: newerVerified,
  });
  assert.equal(passesFilter(entity, config), true);
});

test('does not exclude entity when last_evidence_change_at is within staleness threshold', () => {
  const config: TrustFilterConfig = { ...baseConfig, max_staleness_days: 7 };
  const recentDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const entity = makeEntity({
    last_evidence_change_at: recentDate,
    last_verified_at: null,
  });
  assert.equal(passesFilter(entity, config), true);
});

test('does not apply staleness filter when max_staleness_days is null', () => {
  const config: TrustFilterConfig = { ...baseConfig, max_staleness_days: null };
  const staleDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const entity = makeEntity({
    last_evidence_change_at: staleDate,
    last_verified_at: null,
  });
  assert.equal(passesFilter(entity, config), true);
});

test('does not flag entity without last_evidence_change_at as stale', () => {
  const config: TrustFilterConfig = { ...baseConfig, max_staleness_days: 7 };
  const entity = makeEntity({ last_evidence_change_at: null });
  assert.equal(passesFilter(entity, config), true);
});
