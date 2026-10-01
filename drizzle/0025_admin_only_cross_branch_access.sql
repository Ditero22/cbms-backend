UPDATE users AS account
SET is_cross_branch = 0
FROM roles AS assigned_role
WHERE assigned_role.id = account.role_id
  AND account.is_cross_branch = 1
  AND assigned_role.is_system <> 1;

UPDATE users AS account
SET is_cross_branch = 1
FROM roles AS assigned_role
WHERE assigned_role.id = account.role_id
  AND account.is_cross_branch = 0
  AND assigned_role.is_system = 1;
