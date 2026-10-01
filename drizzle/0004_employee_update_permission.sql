INSERT INTO permissions (key, description)
VALUES ('employees.update', 'Permission to update and change the status of employees.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission_key)
SELECT roles.id, permissions.key
FROM roles
CROSS JOIN permissions
WHERE roles.name = 'Administrator'
  AND permissions.key = 'employees.update'
ON CONFLICT DO NOTHING;
