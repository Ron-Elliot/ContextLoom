CREATE TABLE IF NOT EXISTS derivation_links (
  link_id     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  link_type   TEXT        NOT NULL
                CHECK (link_type IN (
                  'CLAIM_DERIVED_FROM',
                  'RELATIONSHIP_INFERRED_FROM',
                  'ATTRIBUTE_CONTRIBUTED_BY',
                  'RELATIONSHIP_SUPPORTED_BY'
                )),
  source_type TEXT        NOT NULL,
  source_id   UUID        NOT NULL,
  target_type TEXT        NOT NULL,
  target_id   UUID        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
