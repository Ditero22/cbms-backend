CREATE TABLE "delivery_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	CONSTRAINT "delivery_items_quantity_positive" CHECK ("delivery_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_return_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"condition" text NOT NULL,
	"accepted_quantity" numeric(14, 3) DEFAULT '0' NOT NULL,
	CONSTRAINT "order_return_items_quantity_positive" CHECK ("order_return_items"."quantity" > 0),
	CONSTRAINT "order_return_items_condition_valid" CHECK ("order_return_items"."condition" in ('Resalable', 'Damaged', 'Defective', 'Used', 'Lost', 'Non-returnable')),
	CONSTRAINT "order_return_items_accepted_quantity_valid" CHECK ("order_return_items"."accepted_quantity" >= 0 and "order_return_items"."accepted_quantity" <= "order_return_items"."quantity")
);
--> statement-breakpoint
CREATE TABLE "order_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"request_key" text NOT NULL,
	"order_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"notes" text,
	"status" text DEFAULT 'Requested' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"received_by" uuid,
	"received_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejected_at" timestamp with time zone,
	"rejection_notes" text,
	CONSTRAINT "order_returns_reference_unique" UNIQUE("reference"),
	CONSTRAINT "order_returns_request_key_unique" UNIQUE("request_key"),
	CONSTRAINT "order_returns_status_valid" CHECK ("order_returns"."status" in ('Requested', 'Approved', 'Received', 'Rejected'))
);
--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"request_key" text NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"method" text NOT NULL,
	"reason" text NOT NULL,
	"notes" text,
	"status" text DEFAULT 'Requested' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"processed_by" uuid,
	"processed_at" timestamp with time zone,
	"processed_reference" text,
	CONSTRAINT "payment_refunds_reference_unique" UNIQUE("reference"),
	CONSTRAINT "payment_refunds_request_key_unique" UNIQUE("request_key"),
	CONSTRAINT "payment_refunds_amount_positive" CHECK ("payment_refunds"."amount" > 0),
	CONSTRAINT "payment_refunds_status_valid" CHECK ("payment_refunds"."status" in ('Requested', 'Approved', 'Processed', 'Rejected'))
);
--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "reserved_quantity" numeric(14, 3) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "cancelled_quantity" numeric(14, 3) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancelled_by" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancellation_notes" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "completed_by" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "stock_mode" text DEFAULT 'LegacyConsumed' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "stock_mode" SET DEFAULT 'LegacyConsumed';--> statement-breakpoint
UPDATE "orders" SET "stock_mode" = 'LegacyConsumed';--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "stock_mode" SET DEFAULT 'Reserved';--> statement-breakpoint
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_return_items" ADD CONSTRAINT "order_return_items_return_id_order_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."order_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_return_items" ADD CONSTRAINT "order_return_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_processed_by_users_id_fk" FOREIGN KEY ("processed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_items_delivery_order_item_unique" ON "delivery_items" USING btree ("delivery_id","order_item_id");--> statement-breakpoint
CREATE INDEX "delivery_items_order_item_idx" ON "delivery_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_return_items_return_order_item_unique" ON "order_return_items" USING btree ("return_id","order_item_id");--> statement-breakpoint
CREATE INDEX "order_return_items_order_item_idx" ON "order_return_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "order_returns_order_created_idx" ON "order_returns" USING btree ("order_id","requested_at");--> statement-breakpoint
CREATE INDEX "order_returns_delivery_status_idx" ON "order_returns" USING btree ("delivery_id","status");--> statement-breakpoint
CREATE INDEX "payment_refunds_order_created_idx" ON "payment_refunds" USING btree ("order_id","requested_at");--> statement-breakpoint
CREATE INDEX "payment_refunds_payment_status_idx" ON "payment_refunds" USING btree ("payment_id","status");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_reserved_nonnegative" CHECK ("inventory"."reserved_quantity" >= 0);--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_reserved_not_above_quantity" CHECK ("inventory"."reserved_quantity" <= "inventory"."quantity");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_cancelled_quantity_valid" CHECK ("order_items"."cancelled_quantity" >= 0 and "order_items"."cancelled_quantity" <= "order_items"."quantity");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_stock_mode_valid" CHECK ("orders"."stock_mode" in ('Reserved', 'LegacyConsumed'));
--> statement-breakpoint
WITH first_delivered_delivery AS (
  SELECT DISTINCT ON (order_id) id, order_id
    FROM deliveries
   WHERE status = 'Delivered'
   ORDER BY order_id, created_at, id
)
INSERT INTO delivery_items (delivery_id, order_item_id, quantity)
SELECT d.id, oi.id, oi.quantity
  FROM first_delivered_delivery d
  JOIN order_items oi ON oi.order_id = d.order_id;
--> statement-breakpoint
INSERT INTO permissions (key, description) VALUES
  ('orders.complete', 'Permission to complete fully delivered and paid orders.'),
  ('orders.cancel', 'Permission to cancel eligible orders and release outstanding reservations.'),
  ('payments.refund.request', 'Permission to request a payment refund.'),
  ('payments.refund.approve', 'Permission to approve a payment refund request.'),
  ('payments.refund.process', 'Permission to record a processed payment refund.'),
  ('returns.create', 'Permission to request returns for delivered order items.'),
  ('returns.approve', 'Permission to approve order return requests.'),
  ('returns.receive', 'Permission to receive and classify returned order items.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key
  FROM roles r
  JOIN permissions p ON p.key IN (
    'orders.complete', 'orders.cancel', 'payments.refund.request', 'payments.refund.approve',
    'payments.refund.process', 'returns.create', 'returns.approve', 'returns.receive'
  )
 WHERE r.is_system = 1
ON CONFLICT DO NOTHING;
