ALTER TABLE "customers" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
WITH single_branch_customers AS (
  SELECT customer_id, min(branch_id::text)::uuid AS branch_id
  FROM orders
  GROUP BY customer_id
  HAVING count(DISTINCT branch_id) = 1
)
UPDATE customers AS customer
SET branch_id = owner.branch_id
FROM single_branch_customers AS owner
WHERE customer.id = owner.customer_id;--> statement-breakpoint
CREATE INDEX "customers_branch_name_idx" ON "customers" USING btree ("branch_id","name");
