CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id         UUID        PRIMARY KEY,
  project_id          TEXT        NOT NULL,
  source_type         TEXT        NOT NULL,
  source_uri          TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, source_type, source_uri)
);

CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_version_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id         UUID        NOT NULL REFERENCES artifacts(artifact_id),
  content_hash        TEXT        NOT NULL,
  content             TEXT,
  content_ref         TEXT,
  provenance          JSONB       NOT NULL DEFAULT '{}',
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
