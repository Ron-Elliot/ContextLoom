CREATE TABLE IF NOT EXISTS relationships (
  relationship_id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_entity_id          UUID        NOT NULL REFERENCES entities(entity_id),
  to_entity_id            UUID        NOT NULL REFERENCES entities(entity_id),
  relationship_type       TEXT        NOT NULL
                            CHECK (relationship_type IN (
                              'CONTAINS', 'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS',
                              'CONSTRAINS', 'SUPERSEDES', 'RELATED_TO', 'POSSIBLE_DUPLICATE_OF'
                            )),
  review_status           TEXT        NOT NULL DEFAULT 'candidate'
                            CHECK (review_status IN ('candidate', 'reviewed', 'rejected')),
  attention_state         TEXT
                            CHECK (attention_state IN ('conflicted')),
  last_verified_at        TIMESTAMPTZ,
  last_evidence_change_at TIMESTAMPTZ,
  metadata                JSONB       NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
