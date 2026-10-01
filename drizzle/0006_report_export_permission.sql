INSERT INTO permissions (key, description)
VALUES ('reports.export', 'Permission to download authorized CBMS reports.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission_key)
SELECT roles.id, permissions.key
FROM roles
CROSS JOIN permissions
WHERE roles.name = 'Administrator'
  AND permissions.key = 'reports.export'
ON CONFLICT DO NOTHING;
