INSERT INTO permissions (key, description)
VALUES ('expenses.approve', 'Permission to approve or reject pending expenses.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission_key)
SELECT roles.id, permissions.key
FROM roles
CROSS JOIN permissions
WHERE roles.name = 'Administrator'
  AND permissions.key = 'expenses.approve'
ON CONFLICT DO NOTHING;
