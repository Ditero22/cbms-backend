CREATE INDEX IF NOT EXISTS "audit_logs_entity_history_idx"
ON "audit_logs" USING btree ("entity_type", "entity_id", "created_at");
