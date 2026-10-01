import type { PoolClient } from 'pg'
import { pool } from '@/database/client.js'

export async function getUserManagementOptions(branchId?: string | null) {
  const [roles, branches] = await Promise.all([
    pool.query<{
      id: string
      name: string
      description: string | null
      isSystem: number
      permissions: string[]
    }>(
      `select r.id, r.name, r.description, r.is_system as "isSystem",
              coalesce(array_agg(rp.permission_key) filter (where rp.permission_key is not null), '{}') as permissions
       from roles r
       left join role_permissions rp on rp.role_id = r.id
       group by r.id
       order by r.name`,
    ),
    pool.query<{ id: string; name: string }>(
      `select id, name from branches
       where deleted_at is null and status = 'Active'${branchId ? ' and id = $1' : ''}
       order by name`,
      branchId ? [branchId] : [],
    ),
  ])

  return { roles: roles.rows, branches: branches.rows }
}

export type RoleRecord = {
  id: string
  name: string
  description: string | null
  isSystem: number
  permissions: string[]
  createdAt: Date
  assignedUserCount: number
  hasOutOfScopeUsers: boolean
}

export async function getRoles(branchId?: string, roleId?: string) {
  const result = await pool.query<RoleRecord>(
    `select r.id, r.name, r.description, r.is_system as "isSystem", r.created_at as "createdAt",
            (select count(*)::int from users u where u.role_id = r.id and u.deleted_at is null
              and ($1::uuid is null or (u.branch_id = $1 and (u.is_cross_branch = 0 or r.is_system = 0)))) as "assignedUserCount",
            exists(select 1 from users u where u.role_id = r.id and u.deleted_at is null
              and $1::uuid is not null and (u.branch_id is distinct from $1 or (u.is_cross_branch = 1 and r.is_system = 1))) as "hasOutOfScopeUsers",
            coalesce(array_agg(rp.permission_key) filter (where rp.permission_key is not null), '{}') as permissions
     from roles r
     left join role_permissions rp on rp.role_id = r.id
     where ($2::uuid is null or r.id = $2)
     group by r.id
     order by r.name`,
    [branchId ?? null, roleId ?? null],
  )

  return result.rows
}

export async function getRoleById(client: PoolClient, roleId: string) {
  const result = await client.query<{
    id: string
    name: string
    description: string | null
    is_system: number
    permissions: string[]
  }>(
    `select r.id, r.name, r.description, r.is_system,
            coalesce(array_agg(rp.permission_key) filter (where rp.permission_key is not null), '{}') as permissions
     from roles r
     left join role_permissions rp on rp.role_id = r.id
     where r.id = $1
     group by r.id`,
    [roleId],
  )

  return result.rows[0]
}

export async function insertRole(
  client: PoolClient,
  values: { name: string; description: string | null },
) {
  const result = await client.query<{ id: string }>(
    'insert into roles (name, description, is_system) values ($1, $2, 0) returning id',
    [values.name, values.description],
  )

  return result.rows[0]?.id
}

export async function lockRole(client: PoolClient, roleId: string) {
  await client.query('select id from roles where id = $1 for update', [roleId])
}

export async function lockAccountRoles(client: PoolClient, roleIds: string[]) {
  await client.query('select id from roles where id = any($1::uuid[]) order by id for update', [
    roleIds,
  ])
}

export async function lockSystemAdministratorRole(client: PoolClient) {
  await client.query('select id from roles where is_system = 1 for update')
}

export async function setRolePermissions(
  client: PoolClient,
  roleId: string,
  permissions: string[],
) {
  await client.query('delete from role_permissions where role_id = $1', [roleId])
  if (permissions.length === 0) return

  await client.query(
    `insert into role_permissions (role_id, permission_key)
     select $1, granted.permission_key
     from unnest($2::text[]) as granted(permission_key)`,
    [roleId, permissions],
  )
}

export async function updateRole(
  client: PoolClient,
  roleId: string,
  values: { name?: string | undefined; description?: string | null | undefined },
) {
  await client.query(
    `update roles
     set name = coalesce($2, name), description = case when $3 then $4 else description end
     where id = $1`,
    [roleId, values.name ?? null, values.description !== undefined, values.description ?? null],
  )
}

export async function countUsersInRole(client: PoolClient, roleId: string) {
  const result = await client.query<{ count: string }>(
    'select count(*)::text as count from users where role_id = $1',
    [roleId],
  )
  return Number(result.rows[0]?.count ?? 0)
}

export async function hasRoleUsersOutsideBranch(
  client: PoolClient,
  roleId: string,
  branchId: string,
) {
  const result = await client.query<{ exists: boolean }>(
    `select exists(select 1 from users u join roles r on r.id = u.role_id
      where u.role_id = $1 and u.deleted_at is null
      and (u.branch_id is distinct from $2::uuid or (u.is_cross_branch = 1 and r.is_system = 1))) as exists`,
    [roleId, branchId],
  )
  return result.rows[0]?.exists ?? false
}

export function revokeRoleSessions(client: PoolClient, roleId: string) {
  return client.query(
    'delete from user_sessions where user_id in (select id from users where role_id = $1)',
    [roleId],
  )
}

export async function deleteRole(client: PoolClient, roleId: string) {
  await client.query('delete from roles where id = $1', [roleId])
}

export async function insertRoleAudit(
  client: PoolClient,
  values: {
    userId: string
    roleId: string
    action: string
    data: unknown
    oldData?: unknown
    branchId?: string | null
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    `insert into audit_logs (user_id, action, entity_type, entity_id, new_value, ip_address, request_id, old_value, branch_id)
     values ($1, $2, 'role', $3, $4, $5, $6, $7, $8)`,
    [
      values.userId,
      values.action,
      values.roleId,
      values.data,
      values.ipAddress,
      values.requestId,
      values.oldData ?? null,
      values.branchId ?? null,
    ],
  )
}

export async function insertUser(
  client: PoolClient,
  values: {
    name: string
    email: string
    passwordHash: string
    roleId: string
    branchId: string | null
    isCrossBranch: boolean
  },
) {
  const result = await client.query<{ id: string }>(
    `insert into users (name, email, password_hash, role_id, branch_id, is_cross_branch, status)
     values ($1, $2, $3, $4, $5, $6, 'Active')
     returning id`,
    [
      values.name,
      values.email,
      values.passwordHash,
      values.roleId,
      values.branchId,
      values.isCrossBranch ? 1 : 0,
    ],
  )

  return result.rows[0]?.id
}

export async function getUserById(client: PoolClient, userId: string) {
  const result = await client.query<{
    id: string
    name: string
    role_id: string
    branch_id: string | null
    is_cross_branch: number
    status: string
    is_system_role: number
    permissions: string[]
  }>(
    `select u.id, u.name, u.role_id, u.branch_id, u.is_cross_branch, u.status,
            r.is_system as is_system_role,
            array(select rp.permission_key from role_permissions rp where rp.role_id = u.role_id) as permissions
     from users u
     join roles r on r.id = u.role_id
     where u.id = $1 and u.deleted_at is null
     for update of u`,
    [userId],
  )

  return result.rows[0]
}

export async function updateUser(
  client: PoolClient,
  userId: string,
  values: {
    name?: string | undefined
    roleId?: string | undefined
    branchId?: string | null | undefined
    isCrossBranch?: boolean | undefined
    status?: 'Active' | 'Inactive' | undefined
  },
  revokeSessions: boolean,
) {
  await client.query(
    `update users
     set name = coalesce($2, name),
         role_id = coalesce($3, role_id),
         branch_id = case when $4 then $5 else branch_id end,
         is_cross_branch = coalesce($6, is_cross_branch),
         status = coalesce($7, status),
         updated_at = now()
     where id = $1`,
    [
      userId,
      values.name ?? null,
      values.roleId ?? null,
      values.branchId !== undefined,
      values.branchId ?? null,
      values.isCrossBranch === undefined ? null : values.isCrossBranch ? 1 : 0,
      values.status ?? null,
    ],
  )

  if (revokeSessions) {
    await client.query('delete from user_sessions where user_id = $1', [userId])
  }
}

export async function softDeleteUser(client: PoolClient, userId: string, deletedBy: string) {
  const result = await client.query(
    `update users
        set status = 'Inactive', deleted_at = now(), deleted_by = $2, updated_at = now()
      where id = $1 and deleted_at is null`,
    [userId, deletedBy],
  )
  if (result.rowCount !== 1) return false

  await client.query('delete from user_sessions where user_id = $1', [userId])
  return true
}

export async function resetUserPassword(client: PoolClient, userId: string, passwordHash: string) {
  await client.query(
    `update users
        set password_hash = $2,
            failed_login_attempts = 0,
            locked_until = null,
            updated_at = now()
      where id = $1`,
    [userId, passwordHash],
  )
  await client.query('delete from user_sessions where user_id = $1', [userId])
}

export async function isActiveBranch(client: PoolClient, branchId: string) {
  const result = await client.query(
    `select id from branches where id = $1 and deleted_at is null and status = 'Active'`,
    [branchId],
  )

  return Boolean(result.rows[0])
}

export async function countActiveSystemAdministrators(client: PoolClient) {
  const result = await client.query<{ count: string }>(
    `select count(*)::text as count
     from users u
     join roles r on r.id = u.role_id
     where r.is_system = 1 and u.status = 'Active' and u.deleted_at is null`,
  )

  return Number(result.rows[0]?.count ?? 0)
}

export async function insertUserAudit(
  client: PoolClient,
  values: {
    actorId: string
    userId: string
    action: string
    data: unknown
    oldData?: unknown
    branchId: string | null
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    `insert into audit_logs (user_id, branch_id, action, entity_type, entity_id, new_value, ip_address, request_id, old_value)
     values ($1, $2, $3, 'user', $4, $5, $6, $7, $8)`,
    [
      values.actorId,
      values.branchId,
      values.action,
      values.userId,
      values.data,
      values.ipAddress,
      values.requestId,
      values.oldData ?? null,
    ],
  )
}
