CREATE TABLE IF NOT EXISTS entities (
  entity_id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            TEXT        NOT NULL,
  entity_type           TEXT        NOT NULL,
  name                  TEXT        NOT NULL,
  description           TEXT,
  embedding             vector(1536),
  review_status         TEXT        NOT NULL DEFAULT 'candidate'
                          CHECK (review_status IN ('candidate', 'reviewed', 'rejected')),
  attention_state       TEXT
                          CHECK (attention_state IN ('conflicted')),
  last_verified_at      TIMESTAMPTZ,
  last_evidence_change_at TIMESTAMPTZ,
  metadata              JSONB       NOT NULL DEFAULT '{}',
  search_vector         tsvector    GENERATED ALWAYS AS (
                          to_tsvector('english',
                            coalesce(name, '') || ' ' || coalesce(description, ''))
                        ) STORED,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
