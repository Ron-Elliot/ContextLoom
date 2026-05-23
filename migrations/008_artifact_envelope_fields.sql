-- Originally added source_modified_at, extractor, tags, envelope_version to artifact_versions.
-- Those columns were retroactively included in 002_artifacts.sql; migration 008 is retained
-- for migration-tracker sequence integrity only (the IF NOT EXISTS guards make it a no-op).
ALTER TABLE artifact_versions
  ADD COLUMN IF NOT EXISTS source_modified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extractor           TEXT,
  ADD COLUMN IF NOT EXISTS tags                JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS envelope_version    TEXT  NOT NULL DEFAULT '1';
