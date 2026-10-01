ALTER TABLE "vehicles" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
-- Infer legacy ownership only when all known operational history uses one branch.
-- Unused or cross-branch vehicles stay unassigned for explicit Administrator review.
WITH historical_vehicle_branches AS (
  SELECT vehicle_id, branch_id FROM vehicle_assignments WHERE branch_id IS NOT NULL
  UNION ALL
  SELECT vehicle_id, branch_id FROM vehicle_maintenance WHERE branch_id IS NOT NULL
), single_branch_owners AS (
  SELECT vehicle_id, (array_agg(DISTINCT branch_id))[1] AS branch_id
  FROM historical_vehicle_branches
  GROUP BY vehicle_id
  HAVING count(DISTINCT branch_id) = 1
)
UPDATE vehicles AS vehicle
SET branch_id = owner.branch_id
FROM single_branch_owners AS owner
WHERE vehicle.id = owner.vehicle_id AND vehicle.branch_id IS NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vehicles_branch_idx" ON "vehicles" USING btree ("branch_id");
