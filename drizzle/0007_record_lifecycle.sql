ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "deleted_by" uuid;
--> statement-breakpoint
INSERT INTO permissions (key, description)
VALUES
  ('branches.update', 'Permission to edit, change status, and archive branches.'),
  ('customers.update', 'Permission to edit, change status, and archive customers.'),
  ('suppliers.update', 'Permission to edit, change status, and archive suppliers.'),
  ('products.update', 'Permission to edit, change status, and archive products.'),
  ('vehicles.update', 'Permission to edit, change status, and archive vehicles.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission_key)
SELECT roles.id, permissions.key
FROM roles
CROSS JOIN permissions
WHERE roles.name = 'Administrator'
  AND permissions.key IN (
    'branches.update', 'customers.update', 'suppliers.update',
    'products.update', 'vehicles.update'
  )
ON CONFLICT DO NOTHING;
