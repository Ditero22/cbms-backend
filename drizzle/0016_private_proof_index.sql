CREATE INDEX IF NOT EXISTS attachments_entity_created_idx ON attachments(entity_type, entity_id, created_at);
