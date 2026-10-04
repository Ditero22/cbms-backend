UPDATE roles
SET description = 'Full access to all Materials Supply Operations & Finance modules.'
WHERE name = 'Administrator'
  AND is_system = 1
  AND description = 'Full access to all CBMS modules.';
--> statement-breakpoint
UPDATE permissions
SET description = 'Permission to download authorized reports from Materials Supply Operations & Finance.'
WHERE key = 'reports.export'
  AND description = 'Permission to download authorized CBMS reports.';
