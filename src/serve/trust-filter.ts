import type { Entity, TrustFilterConfig } from './types';

export function passesFilter(entity: Entity, config: TrustFilterConfig): boolean {
  if (!config.allow_review_statuses.includes(entity.review_status)) {
    return false;
  }

  if (!config.include_conflicted && entity.attention_state === 'conflicted') {
    return false;
  }

  if (config.max_staleness_days !== null) {
    const isStale =
      entity.last_evidence_change_at !== null &&
      (entity.last_verified_at === null ||
        entity.last_evidence_change_at > entity.last_verified_at) &&
      Date.now() - entity.last_evidence_change_at.getTime() >
        config.max_staleness_days * 24 * 60 * 60 * 1000;
    if (isStale) {
      return false;
    }
  }

  return true;
}

export function applyFilter(entities: Entity[], config: TrustFilterConfig): Entity[] {
  return entities.filter((e) => passesFilter(e, config));
}
