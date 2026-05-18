export interface Entity {
  entity_id: string;
  project_id: string;
  entity_type: string;
  name: string;
  description: string | null;
  review_status: string;
  attention_state: string | null;
  last_verified_at: Date | null;
  last_evidence_change_at: Date | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface EntityClaim {
  claim_id: string;
  subject_type: 'entity';
  subject_id: string;
  claim_type: string;
  value: unknown;
  review_status: string;
  last_verified_at: Date | null;
  last_evidence_change_at: Date | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface ArtifactRef {
  artifact_id: string;
  source_uri: string;
}

export interface Artifact {
  artifact_id: string;
  project_id: string;
  source_type: string;
  source_uri: string;
  created_at: Date;
}

export interface ArtifactVersion {
  artifact_version_id: string;
  artifact_id: string;
  content_hash: string;
  content: string | null;
  content_ref: string | null;
  provenance: Record<string, unknown>;
  source_modified_at: Date | null;
  extractor: string | null;
  tags: unknown[];
  envelope_version: string;
  ingested_at: Date;
}

export interface ArtifactEnvelope {
  artifact: Artifact;
  artifact_version: ArtifactVersion;
}

export interface ArtifactClaim {
  claim_id: string;
  subject_type: 'artifact';
  subject_id: string;
  claim_type: string;
  value: unknown;
  review_status: string;
  last_verified_at: Date | null;
  last_evidence_change_at: Date | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface TrustFilterConfig {
  allow_review_statuses: string[];
  include_conflicted: boolean;
  max_staleness_days: number | null;
}

export const DEFAULT_TRUST_FILTER: TrustFilterConfig = {
  allow_review_statuses: ['reviewed'],
  include_conflicted: false,
  max_staleness_days: null,
};
