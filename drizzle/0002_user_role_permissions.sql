INSERT INTO permissions (key, description)
VALUES
  ('users.update', 'Permission to update user accounts and branch assignments.'),
  ('orders.create', 'Permission to place customer orders.'),
  ('roles.read', 'Permission to view roles and their permissions.'),
  ('roles.create', 'Permission to create roles using permissions already held.'),
  ('roles.update', 'Permission to update roles using permissions already held.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission_key)
SELECT roles.id, permissions.key
FROM roles
CROSS JOIN permissions
WHERE roles.name = 'Administrator'
  AND permissions.key IN ('users.update', 'orders.create', 'roles.read', 'roles.create', 'roles.update')
ON CONFLICT DO NOTHING;
