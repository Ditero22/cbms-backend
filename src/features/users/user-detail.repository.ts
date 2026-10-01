import { pool } from '@/database/client.js'

export type SafeUserRecord = {
  id: string
  name: string
  email: string
  roleId: string
  roleName: string
  roleDescription: string | null
  branchId: string | null
  branchName: string | null
  isCrossBranch: boolean
  status: 'Active' | 'Inactive'
  createdAt: Date
  updatedAt: Date
  lastLoginAt: Date | null
  permissions: string[]
}

export async function getUserDetail(userId: string, branchId?: string) {
  const result = await pool.query<SafeUserRecord>(
    `select u.id, u.name, u.email, u.role_id as "roleId", r.name as "roleName",
            r.description as "roleDescription", u.branch_id as "branchId", b.name as "branchName",
            (u.is_cross_branch = 1 and r.is_system = 1) as "isCrossBranch", u.status,
            u.created_at as "createdAt", u.updated_at as "updatedAt", u.last_login_at as "lastLoginAt",
            array(select rp.permission_key from role_permissions rp where rp.role_id = r.id order by rp.permission_key) as permissions
     from users u join roles r on r.id = u.role_id
     left join branches b on b.id = u.branch_id
     where u.id = $1 and u.deleted_at is null and ($2::uuid is null or u.branch_id = $2)`,
    [userId, branchId ?? null],
  )
  return result.rows[0]
}

export type AccountHistoryEntry = {
  id: string
  action: string
  actorName: string
  oldValue: Record<string, unknown> | null
  newValue: Record<string, unknown> | null
  createdAt: Date
}

export async function getManagementHistory(
  entityType: 'user' | 'role',
  entityId: string,
  page: number,
  pageSize: number,
  branchId?: string,
) {
  const parameters = [entityType, entityId, branchId ?? null]
  const count = await pool.query<{ total: number }>(
    `select count(*)::int as total from audit_logs
     where entity_type = $1 and entity_id = $2 and ($3::uuid is null or branch_id = $3)`,
    parameters,
  )
  const result = await pool.query<AccountHistoryEntry>(
    `select a.id, a.action, coalesce(u.name, 'Former user') as "actorName",
            a.old_value as "oldValue", a.new_value as "newValue", a.created_at as "createdAt"
     from audit_logs a left join users u on u.id = a.user_id
     where a.entity_type = $1 and a.entity_id = $2 and ($3::uuid is null or a.branch_id = $3)
     order by a.created_at desc, a.id desc limit $4 offset $5`,
    [...parameters, pageSize, (page - 1) * pageSize],
  )
  return { items: result.rows, total: count.rows[0]?.total ?? 0 }
}
