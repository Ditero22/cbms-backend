ALTER TABLE "orders" ADD COLUMN "request_key" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_request_key_unique" ON "orders" USING btree ("request_key");