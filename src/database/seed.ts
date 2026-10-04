import { hashPassword } from '@/shared/security/password.js'
import { env } from '@/config/env.js'
import { pool } from './client.js'
import { permissionKeys } from './permissions.js'

if (!env.isDevelopment) {
  throw new Error('Development bootstrap seeding is only available in development mode.')
}

async function seed() {
  if (!env.bootstrapAdminPassword) {
    throw new Error('Set BOOTSTRAP_ADMIN_PASSWORD in the local environment before seeding.')
  }
  const passwordHash = await hashPassword(env.bootstrapAdminPassword)
  const client = await pool.connect()
  try {
    await client.query('begin')
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
      `insert into users (email, name, password_hash, role_id, is_cross_branch, status)
       values ($1, $2, $3, $4, 1, 'Active')
       on conflict (email) do update set name = excluded.name, password_hash = excluded.password_hash,
         role_id = excluded.role_id, is_cross_branch = 1, status = 'Active', deleted_at = null`,
      [env.bootstrapAdminEmail, env.bootstrapAdminName, passwordHash, roleId],
    )
    await client.query('commit')
    console.info(`Local administrator is ready: ${env.bootstrapAdminEmail}`)
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

try {
  await seed()
} finally {
  await pool.end()
}
