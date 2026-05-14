ALTER TABLE entities
  ADD CONSTRAINT entities_project_entity_name_unique
  UNIQUE (project_id, entity_type, name);
