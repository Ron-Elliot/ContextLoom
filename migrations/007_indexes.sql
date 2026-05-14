-- Full-text search index on entities (name + description)
CREATE INDEX IF NOT EXISTS entities_search_vector_gin
  ON entities USING GIN (search_vector);

-- pgvector similarity index on entity embeddings
CREATE INDEX IF NOT EXISTS entities_embedding_ivfflat
  ON entities USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Claims lookup by subject
CREATE INDEX IF NOT EXISTS claims_subject_idx
  ON claims (subject_type, subject_id);

-- Relationship traversal indexes
CREATE INDEX IF NOT EXISTS relationships_from_entity_idx
  ON relationships (from_entity_id);

CREATE INDEX IF NOT EXISTS relationships_to_entity_idx
  ON relationships (to_entity_id);

-- Derivation link traversal indexes
CREATE INDEX IF NOT EXISTS derivation_links_source_idx
  ON derivation_links (source_type, source_id);

CREATE INDEX IF NOT EXISTS derivation_links_target_idx
  ON derivation_links (target_type, target_id);
