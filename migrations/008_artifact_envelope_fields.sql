ALTER TABLE artifact_versions
  ADD COLUMN IF NOT EXISTS source_modified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extractor           TEXT,
  ADD COLUMN IF NOT EXISTS tags                JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS envelope_version    TEXT  NOT NULL DEFAULT '1';
