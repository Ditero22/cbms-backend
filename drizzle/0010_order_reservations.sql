CREATE TABLE "order_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"fulfilled_quantity" numeric(14, 3) DEFAULT '0' NOT NULL,
	"released_quantity" numeric(14, 3) DEFAULT '0' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_reservations_quantity_positive" CHECK ("order_reservations"."quantity" > 0),
	CONSTRAINT "order_reservations_fulfilled_nonnegative" CHECK ("order_reservations"."fulfilled_quantity" >= 0),
	CONSTRAINT "order_reservations_released_nonnegative" CHECK ("order_reservations"."released_quantity" >= 0),
	CONSTRAINT "order_reservations_accounted_quantity_valid" CHECK ("order_reservations"."fulfilled_quantity" + "order_reservations"."released_quantity" <= "order_reservations"."quantity")
);
--> statement-breakpoint
DROP INDEX "delivery_items_delivery_order_item_unique";--> statement-breakpoint
ALTER TABLE "delivery_items" ADD COLUMN "reservation_id" uuid;--> statement-breakpoint
ALTER TABLE "order_reservations" ADD CONSTRAINT "order_reservations_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_reservations" ADD CONSTRAINT "order_reservations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_reservations_order_item_idx" ON "order_reservations" USING btree ("order_item_id");--> statement-breakpoint
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_reservation_id_order_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."order_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_items_delivery_idx" ON "delivery_items" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "delivery_items_reservation_idx" ON "delivery_items" USING btree ("reservation_id");--> statement-breakpoint
ALTER TABLE "order_return_items" ADD CONSTRAINT "order_return_items_non_resalable_not_restocked" CHECK ("order_return_items"."condition" = 'Resalable' or "order_return_items"."accepted_quantity" = 0);