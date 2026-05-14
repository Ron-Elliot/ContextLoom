CREATE TABLE IF NOT EXISTS claims (
  claim_id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type            TEXT        NOT NULL
                            CHECK (subject_type IN ('entity', 'artifact')),
  subject_id              UUID        NOT NULL,
  claim_type              TEXT        NOT NULL,
  value                   TEXT        NOT NULL,
  review_status           TEXT        NOT NULL DEFAULT 'candidate'
                            CHECK (review_status IN ('candidate', 'reviewed', 'rejected')),
  last_verified_at        TIMESTAMPTZ,
  last_evidence_change_at TIMESTAMPTZ,
  metadata                JSONB       NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
