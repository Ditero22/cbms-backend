ALTER TABLE "inventory_transactions" ADD COLUMN "request_key" text;--> statement-breakpoint
CREATE INDEX "inventory_transactions_stock_ledger_idx" ON "inventory_transactions" USING btree ("product_id","branch_id","created_at","id");--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_request_key_unique" UNIQUE("request_key");
--> statement-breakpoint
INSERT INTO permissions (key, description)
VALUES ('inventory.reorder', 'Permission to maintain branch-specific inventory reorder points.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission_key)
SELECT roles.id, permissions.key FROM roles CROSS JOIN permissions
WHERE roles.name = 'Administrator' AND permissions.key = 'inventory.reorder'
ON CONFLICT DO NOTHING;
