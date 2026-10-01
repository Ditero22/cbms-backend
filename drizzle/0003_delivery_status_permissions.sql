INSERT INTO permissions (key, description)
VALUES ('deliveries.update', 'Permission to update delivery status through its allowed lifecycle.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission_key)
SELECT roles.id, permissions.key
FROM roles
CROSS JOIN permissions
WHERE roles.name = 'Administrator'
  AND permissions.key = 'deliveries.update'
ON CONFLICT DO NOTHING;
