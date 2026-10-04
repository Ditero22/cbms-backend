import { env } from '@/config/env.js'
import { hashPassword } from '@/shared/security/password.js'
import { pool } from './client.js'
import { permissionKeys } from './permissions.js'

if (!process.env.BOOTSTRAP_ADMIN_EMAIL || !process.env.BOOTSTRAP_ADMIN_PASSWORD) {
  throw new Error(
    'Set a unique BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD for this one-time operation.',
  )
}

async function provisionAdministrator() {
  const passwordHash = await hashPassword(env.bootstrapAdminPassword)
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('lock table users in exclusive mode')
    const existing = await client.query('select count(*)::int as count from users')
    if (Number(existing.rows[0]?.count) > 0) {
      throw new Error(
        'Administrator provisioning stopped because the database already contains a user.',
      )
    }

    await client.query(
      "insert into roles (name, description, is_system) values ('Administrator', 'Full access to all Materials Supply Operations & Finance modules.', 1) on conflict (name) do nothing",
    )
    for (const permission of permissionKeys) {
      await client.query(
        'insert into permissions (key, description) values ($1, $2) on conflict (key) do nothing',
        [permission, `Permission to use ${permission.replaceAll('.', ' ')}.`],
      )
    }
    const roleResult = await client.query("select id from roles where name = 'Administrator'")
    const roleId = roleResult.rows[0]?.id as string | undefined
    if (!roleId) throw new Error('Unable to create administrator role.')
    for (const permission of permissionKeys) {
      await client.query(
        'insert into role_permissions (role_id, permission_key) values ($1, $2) on conflict do nothing',
        [roleId, permission],
      )
    }
    await client.query(
      "insert into users (email, name, password_hash, role_id, is_cross_branch, status) values ($1, $2, $3, $4, 1, 'Active')",
      [env.bootstrapAdminEmail, env.bootstrapAdminName, passwordHash, roleId],
    )
    await client.query('commit')
    console.info('One-time administrator provisioned successfully.')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

try {
  await provisionAdministrator()
} finally {
  await pool.end()
}
