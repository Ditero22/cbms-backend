ALTER TABLE "inventory_transactions" ADD COLUMN "ledger_sequence" bigserial NOT NULL;--> statement-breakpoint
-- Preserve legacy ledger order while future inserts follow the stock-row lock order.
-- The migration transaction holds the ALTER TABLE lock throughout backfill/indexing.
WITH ordered AS (
  SELECT id,row_number() OVER (ORDER BY created_at,id) AS position
  FROM inventory_transactions
)
UPDATE inventory_transactions it SET ledger_sequence=ordered.position
FROM ordered WHERE ordered.id=it.id;--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('inventory_transactions','ledger_sequence'),
  coalesce((SELECT max(ledger_sequence) FROM inventory_transactions),1),
  EXISTS(SELECT 1 FROM inventory_transactions));--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_transactions_ledger_sequence_unique" ON "inventory_transactions" USING btree ("ledger_sequence");--> statement-breakpoint
CREATE INDEX "inventory_transactions_stock_sequence_idx" ON "inventory_transactions" USING btree ("product_id","branch_id","ledger_sequence");
