ALTER TABLE "deliveries" ADD COLUMN "allocation_origin" text DEFAULT 'Recorded' NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "allocation_status" text DEFAULT 'Verified' NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "allocation_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "allocation_verified_by" uuid;--> statement-breakpoint
ALTER TABLE "delivery_items" ADD COLUMN "inferred_quantity" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_allocation_verified_by_users_id_fk" FOREIGN KEY ("allocation_verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_allocation_origin_valid" CHECK ("deliveries"."allocation_origin" in ('Recorded', 'LegacyBackfill'));--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_allocation_status_valid" CHECK ("deliveries"."allocation_status" in ('Verified', 'Unverified'));--> statement-breakpoint
UPDATE delivery_items di
   SET inferred_quantity = di.quantity
  FROM deliveries d
  JOIN orders o ON o.id = d.order_id
 WHERE di.delivery_id = d.id
   AND o.stock_mode = 'LegacyConsumed'
   AND di.reservation_id IS NULL
   AND d.status IN ('Preparing', 'Scheduled', 'In Transit', 'Delivered');--> statement-breakpoint
UPDATE deliveries d
   SET allocation_origin = 'LegacyBackfill', allocation_status = 'Unverified'
  FROM orders o
 WHERE o.id = d.order_id
   AND o.stock_mode = 'LegacyConsumed'
   AND d.status IN ('Preparing', 'Scheduled', 'In Transit', 'Delivered')
   AND EXISTS (
     SELECT 1 FROM delivery_items di
      WHERE di.delivery_id = d.id AND di.inferred_quantity IS NOT NULL
   );
