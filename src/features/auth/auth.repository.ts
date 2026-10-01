import { pool } from '@/database/client.js'
import { withTransaction } from '@/database/transaction.js'

export type AuthAccount = {
  id: string
  name: string
  email: string
  password_hash: string
  branch_id: string | null
  is_cross_branch: number
  status: string
  failed_login_attempts: number
  locked_until: Date | string | null
  role: string
  is_system_role: number
  branch: string
  permissions: string[]
}

export type AuthSession = {
  id: string
  name: string
  email: string
  branchId: string | null
  isCrossBranch: number
  role: string
  branch: string
  permissions: string[]
  sessionId: string
  expiresAt: Date | string
}

export async function findAccountByEmail(email: string) {
  const result = await pool.query<AuthAccount>(
    `select u.id, u.name, u.email, u.password_hash, u.role_id, u.branch_id,
            u.is_cross_branch, r.is_system as is_system_role,
            u.status, u.failed_login_attempts, u.locked_until, r.name as role,
            coalesce(b.name, 'Unassigned') as branch,
            coalesce(array_agg(rp.permission_key) filter (where rp.permission_key is not null), '{}') as permissions
     from users u join roles r on r.id = u.role_id
     left join branches b on b.id = u.branch_id
     left join role_permissions rp on rp.role_id = r.id
     where u.email = $1 and u.deleted_at is null
     group by u.id, r.name, r.is_system, b.name`,
    [email],
  )

  return result.rows[0]
}

export function recordFailedLogin(userId: string) {
  return pool.query(
    `update users set failed_login_attempts =
       case when locked_until <= now() then 1 else failed_login_attempts + 1 end,
     locked_until = case
       when locked_until <= now() then null
       when failed_login_attempts + 1 >= 8 then now() + interval '15 minutes'
       else null end
     where id = $1`,
    [userId],
  )
}

export async function createSession(
  userId: string,
  tokenHash: string,
  expiresAt: Date,
  ipAddress: string | null,
  userAgent: string | null,
  expectedPasswordHash: string,
) {
  return withTransaction(async (client) => {
    // Password verification happens outside the transaction. Recheck the account
    // under its row lock so a reset/deactivation cannot be undone by an in-flight login.
    const account = await client.query(
      `update users set failed_login_attempts = 0, locked_until = null, last_login_at = now()
       where id = $1 and password_hash = $2 and status = 'Active' and deleted_at is null
         and (locked_until is null or locked_until <= now()) returning id`,
      [userId, expectedPasswordHash],
    )
    if (account.rowCount !== 1) return false
    await client.query('delete from user_sessions where user_id = $1 and expires_at <= now()', [
      userId,
    ])
    await client.query(
      'insert into user_sessions (user_id, token_hash, expires_at, ip_address, user_agent) values ($1, $2, $3, $4, $5)',
      [userId, tokenHash, expiresAt, ipAddress, userAgent],
    )
    return true
  })
}

export async function findSessionByTokenHash(tokenHash: string) {
  const result = await pool.query<AuthSession>(
    `select u.id, u.name, u.email, u.branch_id as "branchId",
            case when r.is_system = 1 then u.is_cross_branch else 0 end as "isCrossBranch",
            r.name as role, coalesce(b.name, 'Unassigned') as branch,
            coalesce(array_agg(rp.permission_key) filter (where rp.permission_key is not null), '{}') as permissions,
            s.id as "sessionId", s.expires_at as "expiresAt"
     from user_sessions s
     join users u on u.id = s.user_id
     join roles r on r.id = u.role_id
     left join branches b on b.id = u.branch_id
     left join role_permissions rp on rp.role_id = r.id
     where s.token_hash = $1 and u.status = 'Active' and u.deleted_at is null
     group by u.id, r.name, r.is_system, b.name, s.id, s.expires_at`,
    [tokenHash],
  )

  return result.rows[0]
}

export function deleteSessionById(sessionId: string) {
  return pool.query('delete from user_sessions where id = $1', [sessionId])
}

export function updateSessionLastSeen(sessionId: string) {
  return pool.query('update user_sessions set last_seen_at = now() where id = $1', [sessionId])
}

export function deleteSessionByTokenHash(tokenHash: string) {
  return pool.query('delete from user_sessions where token_hash = $1', [tokenHash])
}
