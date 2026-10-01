import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '@/app.js'
import { pool } from '@/database/client.js'
import { permissionKeys } from '@/database/permissions.js'
import {
  createSessionToken,
  hashSessionToken,
  sessionCookieName,
} from '@/shared/security/session.js'
import { createSession, recordFailedLogin } from '@/features/auth/auth.repository.js'
import { hashPassword } from '@/shared/security/password.js'

type ApiError = { error: { code: string } }
type UserDetail = {
  user: {
    id: string
    name: string
    email: string
    roleId: string
    branchId: string | null
    isCrossBranch: boolean
    status: string
    permissions: string[]
    canManage: boolean
    managementReason: string | null
    createdAt: string
    updatedAt: string
    lastLoginAt: string | null
  }
  history: {
    action: string
    oldValue: Record<string, unknown> | null
    newValue: Record<string, unknown> | null
  }[]
  historyTotal: number
  historyPage: number
  historyPageSize: number
}
type RoleRecord = {
  id: string
  name: string
  permissions: string[]
  createdAt: string
  assignedUserCount: number
  canManage: boolean
  managementReason: string | null
}
type RoleDetail = { role: RoleRecord; history: { action: string }[]; historyTotal: number }

const fixture = randomUUID().slice(0, 8)
const initialPassword = `Fixture-only-${randomUUID()}`
const accounts: Record<string, { id: string; email: string; cookie: string; roleId: string }> = {}
let server: Server
let apiUrl: string
let branchId: string
let otherBranchId: string
let inactiveBranchId: string
let systemRoleId: string
let basicRoleId: string
let privilegedRoleId: string
let sharedRoleId: string
let noAuditAdminId: string
let passwordHash: string

async function insertId(query: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(query, values)
  const id = result.rows[0]?.id
  if (!id) throw new Error('The administration fixture could not be created.')
  return id
}

async function createRole(label: string, grants: string[], isSystem = false) {
  const roleId = await insertId(
    'insert into roles (name, description, is_system) values ($1, $2, $3) returning id',
    [`Admin HTTP ${label} ${fixture}`, 'Fixture permission scope', isSystem ? 1 : 0],
  )
  for (const permission of grants)
    await pool.query('insert into role_permissions (role_id, permission_key) values ($1, $2)', [
      roleId,
      permission,
    ])
  return roleId
}

async function createAccount(
  label: string,
  roleId: string,
  assignedBranch: string | null = branchId,
  isCrossBranch = false,
) {
  const email = `admin-http-${label.replaceAll(' ', '-')}-${fixture}@example.invalid`
  const id = await insertId(
    `insert into users (name, email, password_hash, role_id, branch_id, is_cross_branch) values ($1, $2, $3, $4, $5, $6) returning id`,
    [`Admin HTTP ${label}`, email, passwordHash, roleId, assignedBranch, isCrossBranch ? 1 : 0],
  )
  const cookie = await addSession(id)
  accounts[label] = { id, email, cookie, roleId }
  return accounts[label]!
}

async function addSession(userId: string) {
  const token = createSessionToken()
  await pool.query(
    `insert into user_sessions (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 hour')`,
    [userId, hashSessionToken(token)],
  )
  return `${sessionCookieName}=${token}`
}

async function request<T>(
  method: string,
  path: string,
  account?: string,
  body?: Record<string, unknown>,
  cookie?: string,
) {
  const response = await fetch(`${apiUrl}/api/v1${path}`, {
    method,
    headers: {
      ...(cookie || account ? { Cookie: cookie ?? accounts[account!]?.cookie ?? '' } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as T) : (null as T),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  }
}

async function login(email: string, password = initialPassword) {
  return request<{ user: { id: string; permissions: string[] } }>(
    'POST',
    '/auth/login',
    undefined,
    { email, password },
  )
}

async function expectError(
  method: string,
  path: string,
  actor: string | undefined,
  body: Record<string, unknown> | undefined,
  status: number,
  code: string,
) {
  const response = await request<ApiError>(method, path, actor, body)
  expect(response.status).toBe(status)
  expect(response.body.error.code).toBe(code)
}

beforeAll(async () => {
  passwordHash = await hashPassword(initialPassword)
  for (const key of permissionKeys)
    await pool.query(
      'insert into permissions (key, description) values ($1, $2) on conflict (key) do nothing',
      [key, `Administration acceptance ${key}`],
    )
  branchId = await insertId('insert into branches (name, code) values ($1, $2) returning id', [
    'Administration North',
    `ad-n-${fixture}`,
  ])
  otherBranchId = await insertId('insert into branches (name, code) values ($1, $2) returning id', [
    'Administration South',
    `ad-s-${fixture}`,
  ])
  inactiveBranchId = await insertId(
    "insert into branches (name, code, status) values ($1, $2, 'Inactive') returning id",
    ['Administration Closed', `ad-c-${fixture}`],
  )
  systemRoleId = await createRole('system', permissionKeys, true)
  basicRoleId = await createRole('basic', ['users.read'])
  privilegedRoleId = await createRole('privileged', ['users.read', 'reports.export'])
  sharedRoleId = await createRole('shared', ['users.read'])
  const managementPermissions = [
    'users.read',
    'users.create',
    'users.update',
    'roles.read',
    'roles.create',
    'roles.update',
    'audit.read',
    'products.read',
  ]
  const managerRoleId = await createRole('manager', managementPermissions)
  const managementAdminRoleId = await createRole('restricted admin', managementPermissions, true)
  const noAuditAdminRoleId = await createRole(
    'admin without audit access',
    ['users.read', 'roles.read'],
    true,
  )
  await createAccount('administrator', systemRoleId, null, true)
  await createAccount('manager', managerRoleId)
  await createAccount('managementAdmin', managementAdminRoleId, null, true)
  noAuditAdminId = (await createAccount('noAuditAdmin', noAuditAdminRoleId, null, true)).id
  await createAccount('globalManager', systemRoleId, null, true)
  await createAccount('viewer', await createRole('viewer', ['users.read', 'roles.read']))
  await createAccount('outsider', basicRoleId, otherBranchId)
  await createAccount('privileged', privilegedRoleId)
  await createAccount('crossBranch', basicRoleId, branchId, true)
  await createAccount('sharedLocal', sharedRoleId)
  await createAccount('sharedOther', sharedRoleId, otherBranchId)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The test server could not start.')
  apiUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  await pool.end()
})

describe('Users & Roles through authenticated HTTP and PostgreSQL', () => {
  it('validates route IDs and payloads and enforces read/write permissions', async () => {
    await expectError(
      'GET',
      `/users/${accounts.manager!.id}`,
      undefined,
      undefined,
      401,
      'AUTH_REQUIRED',
    )
    await expectError(
      'PATCH',
      `/users/${accounts.manager!.id}`,
      'viewer',
      { name: 'Forged edit' },
      403,
      'FORBIDDEN',
    )
    await expectError(
      'POST',
      '/roles',
      'viewer',
      { name: 'Forbidden', permissions: [] },
      403,
      'FORBIDDEN',
    )
    await expectError(
      'GET',
      '/users/not-a-uuid',
      'managementAdmin',
      undefined,
      400,
      'INVALID_RECORD_ID',
    )
    await expectError(
      'GET',
      `/roles/${basicRoleId}?historyPage=0`,
      'managementAdmin',
      undefined,
      400,
      'VALIDATION_ERROR',
    )
    await expectError(
      'PATCH',
      `/users/${accounts.privileged!.id}`,
      'administrator',
      { password_hash: 'forged' },
      400,
      'VALIDATION_ERROR',
    )
    await expectError(
      'POST',
      '/roles',
      'managementAdmin',
      { name: 'Repeated grant', permissions: ['users.read', 'users.read'] },
      400,
      'VALIDATION_ERROR',
    )
  })

  it('creates a normalized account with safe detail, role/branch validation, and secret-free audit', async () => {
    const email = `Created-${fixture}@Example.Invalid`
    const payload = {
      name: 'Created account',
      email,
      password: initialPassword,
      roleId: basicRoleId,
      branchId,
      isCrossBranch: false,
    }
    const response = await request<{ id: string }>('POST', '/users', 'managementAdmin', payload)
    expect(response.status).toBe(201)
    const detail = await request<UserDetail>('GET', `/users/${response.body.id}`, 'managementAdmin')
    expect(detail.status).toBe(200)
    expect(detail.body.user).toMatchObject({
      name: payload.name,
      email: email.toLowerCase(),
      roleId: basicRoleId,
      branchId,
      isCrossBranch: false,
      status: 'Active',
      permissions: ['users.read'],
      canManage: true,
      lastLoginAt: null,
    })
    expect(Date.parse(detail.body.user.createdAt)).not.toBeNaN()
    expect(detail.body.history).toHaveLength(1)
    expect(detail.body.history[0]?.action).toBe('created user')
    expect(JSON.stringify(detail.body)).not.toMatch(
      /password|token|scrypt|failedLoginAttempts|lockedUntil/,
    )
    await expectError('POST', '/users', 'managementAdmin', payload, 409, 'DUPLICATE_USER')
    await expectError(
      'POST',
      '/users',
      'managementAdmin',
      { ...payload, email: `bad-role-${fixture}@example.invalid`, roleId: randomUUID() },
      404,
      'ROLE_NOT_FOUND',
    )
    await expectError(
      'POST',
      '/users',
      'managementAdmin',
      { ...payload, email: `closed-${fixture}@example.invalid`, branchId: inactiveBranchId },
      404,
      'BRANCH_NOT_FOUND',
    )
    await expectError(
      'POST',
      '/users',
      'administrator',
      { ...payload, email: `closed-global-${fixture}@example.invalid`, branchId: inactiveBranchId },
      404,
      'BRANCH_NOT_FOUND',
    )
    await expectError(
      'POST',
      '/users',
      'managementAdmin',
      { ...payload, email: `grant-${fixture}@example.invalid`, roleId: privilegedRoleId },
      403,
      'PERMISSION_ESCALATION',
    )
    await expectError(
      'POST',
      '/users',
      'managementAdmin',
      {
        ...payload,
        email: `global-${fixture}@example.invalid`,
        branchId: null,
        isCrossBranch: true,
      },
      403,
      'ADMIN_ROLE_REQUIRED',
    )
    await expectError(
      'POST',
      '/users',
      'administrator',
      { ...payload, email: `unassigned-${fixture}@example.invalid`, branchId: null },
      400,
      'BRANCH_REQUIRED',
    )
    await expectError(
      'POST',
      '/users',
      'administrator',
      {
        ...payload,
        email: `global-custom-role-${fixture}@example.invalid`,
        branchId: null,
        isCrossBranch: true,
      },
      403,
      'ADMIN_ROLE_REQUIRED',
    )
    await expectError(
      'POST',
      '/users',
      'administrator',
      {
        ...payload,
        email: `local-system-admin-${fixture}@example.invalid`,
        roleId: systemRoleId,
        isCrossBranch: false,
      },
      400,
      'ADMIN_GLOBAL_REQUIRED',
    )
  })

  it('reserves company-wide access for the system Administrator role', async () => {
    const legacySession = await request<{
      user: { branchId: string | null; isCrossBranch: boolean }
    }>('GET', '/auth/me', 'crossBranch')
    expect(legacySession.body.user).toMatchObject({ branchId, isCrossBranch: false })
    await expectError(
      'PATCH',
      `/users/${accounts.administrator!.id}`,
      'globalManager',
      { isCrossBranch: false },
      400,
      'ADMIN_GLOBAL_REQUIRED',
    )
    await expectError(
      'GET',
      `/users/${accounts.outsider!.id}`,
      'crossBranch',
      undefined,
      403,
      'MANAGEMENT_FORBIDDEN',
    )

    const legacyDetail = await request<UserDetail>(
      'GET',
      `/users/${accounts.crossBranch!.id}`,
      'managementAdmin',
    )
    expect(legacyDetail.body.user).toMatchObject({ isCrossBranch: false, canManage: true })

    const branchAccount = await createAccount('global scope attempt', basicRoleId)
    await expectError(
      'PATCH',
      `/users/${branchAccount.id}`,
      'administrator',
      { isCrossBranch: true },
      403,
      'ADMIN_ROLE_REQUIRED',
    )
    const stillScoped = await request<{
      user: { branchId: string | null; isCrossBranch: boolean }
    }>('GET', '/auth/me', 'global scope attempt')
    expect(stillScoped.body.user).toMatchObject({ branchId, isCrossBranch: false })
  })

  it('denies branch managers direct access to Management list, detail, options, and writes', async () => {
    await expectError('GET', '/users', 'manager', undefined, 403, 'MANAGEMENT_FORBIDDEN')
    await expectError('GET', '/users/options', 'manager', undefined, 403, 'MANAGEMENT_FORBIDDEN')
    await expectError('GET', '/roles', 'manager', undefined, 403, 'MANAGEMENT_FORBIDDEN')
    await expectError('GET', '/branches', 'manager', undefined, 403, 'MANAGEMENT_FORBIDDEN')
    await expectError(
      'GET',
      `/users/${accounts.administrator!.id}`,
      'manager',
      undefined,
      403,
      'MANAGEMENT_FORBIDDEN',
    )
    await expectError(
      'GET',
      `/roles/${basicRoleId}`,
      'manager',
      undefined,
      403,
      'MANAGEMENT_FORBIDDEN',
    )
    await expectError(
      'POST',
      '/users',
      'manager',
      {
        name: 'Forbidden manager account',
        email: `forbidden-${fixture}@example.invalid`,
        password: initialPassword,
        roleId: basicRoleId,
        branchId,
        isCrossBranch: false,
      },
      403,
      'MANAGEMENT_FORBIDDEN',
    )
    await expectError(
      'POST',
      '/roles',
      'manager',
      { name: `forbidden-${fixture}`, permissions: [] },
      403,
      'MANAGEMENT_FORBIDDEN',
    )
    await expectError(
      'PATCH',
      `/users/${accounts.administrator!.id}`,
      'manager',
      { name: 'Forged edit' },
      403,
      'MANAGEMENT_FORBIDDEN',
    )
    await expectError(
      'PATCH',
      `/branches/${branchId}`,
      'manager',
      { name: 'Forged edit' },
      403,
      'MANAGEMENT_FORBIDDEN',
    )
    await expectError(
      'PATCH',
      `/branches/${branchId}/archive`,
      'manager',
      {},
      403,
      'MANAGEMENT_FORBIDDEN',
    )
    await expectError(
      'GET',
      `/%75sers/${accounts.administrator!.id}`,
      'manager',
      undefined,
      403,
      'MANAGEMENT_FORBIDDEN',
    )
    const privileged = await request<UserDetail>(
      'GET',
      `/users/${accounts.privileged!.id}`,
      'managementAdmin',
    )
    expect(privileged.body.user.canManage).toBe(false)
    expect(privileged.body.user.managementReason).toContain('permissions beyond')
  })

  it('deactivates and reactivates accounts without reviving old sessions', async () => {
    const account = await createAccount('activation', basicRoleId)
    const loggedIn = await login(account.email)
    expect(loggedIn.status).toBe(200)
    const lastLogin = await request<UserDetail>('GET', `/users/${account.id}`, 'managementAdmin')
    expect(lastLogin.body.user.lastLoginAt).not.toBeNull()
    expect(
      (await request('PATCH', `/users/${account.id}`, 'managementAdmin', { status: 'Inactive' }))
        .status,
    ).toBe(200)
    expect((await request('GET', '/auth/me', undefined, undefined, loggedIn.cookie)).status).toBe(
      401,
    )
    expect((await login(account.email)).status).toBe(401)
    expect(
      (await request('PATCH', `/users/${account.id}`, 'managementAdmin', { status: 'Active' }))
        .status,
    ).toBe(200)
    expect((await request('GET', '/auth/me', undefined, undefined, loggedIn.cookie)).status).toBe(
      401,
    )
    expect((await login(account.email)).status).toBe(200)
    const detail = await request<UserDetail>('GET', `/users/${account.id}`, 'managementAdmin')
    expect(detail.body.history.filter((entry) => entry.action === 'updated user')).toHaveLength(2)
    expect(detail.body.history[0]?.oldValue?.status).toBe('Inactive')
  })

  it('resets passwords, clears lockout, revokes every session, and keeps credentials out of audit', async () => {
    const account = await createAccount('reset', basicRoleId)
    const loggedIn = await login(account.email)
    const anotherSession = await addSession(account.id)
    await pool.query(
      "update users set failed_login_attempts = 8, locked_until = now() + interval '15 minutes' where id = $1",
      [account.id],
    )
    const nextPassword = `Reset-only-${randomUUID()}`
    expect(
      (
        await request('POST', `/users/${account.id}/password`, 'managementAdmin', {
          password: nextPassword,
        })
      ).status,
    ).toBe(200)
    expect((await request('GET', '/auth/me', undefined, undefined, loggedIn.cookie)).status).toBe(
      401,
    )
    expect((await request('GET', '/auth/me', undefined, undefined, anotherSession)).status).toBe(
      401,
    )
    expect((await login(account.email)).status).toBe(401)
    expect((await login(account.email, nextPassword)).status).toBe(200)
    const detail = await request<UserDetail>('GET', `/users/${account.id}`, 'managementAdmin')
    expect(detail.body.history[0]).toMatchObject({
      action: 'reset user password',
      newValue: { sessionsRevoked: true },
    })
    expect(JSON.stringify(detail.body)).not.toContain(nextPassword)
    const stored = await pool.query(
      'select failed_login_attempts, locked_until from users where id = $1',
      [account.id],
    )
    expect(stored.rows[0]).toEqual({ failed_login_attempts: 0, locked_until: null })
  })

  it('revokes sessions on role and branch access changes while preserving metadata-only sessions', async () => {
    const account = await createAccount('assignment', basicRoleId)
    const loggedIn = await login(account.email)
    expect(
      (
        await request('PATCH', `/users/${account.id}`, 'managementAdmin', {
          name: 'Renamed account',
        })
      ).status,
    ).toBe(200)
    expect((await request('GET', '/auth/me', undefined, undefined, loggedIn.cookie)).status).toBe(
      200,
    )
    const roleId = await createRole('assignment replacement', ['users.read', 'products.read'])
    expect(
      (await request('PATCH', `/users/${account.id}`, 'managementAdmin', { roleId })).status,
    ).toBe(200)
    expect((await request('GET', '/auth/me', undefined, undefined, loggedIn.cookie)).status).toBe(
      401,
    )
    const nextLogin = await login(account.email)
    expect(nextLogin.body.user.permissions.sort()).toEqual(['products.read', 'users.read'])
    expect(
      (await request('PATCH', `/users/${account.id}`, 'administrator', { branchId: otherBranchId }))
        .status,
    ).toBe(200)
    expect((await request('GET', '/auth/me', undefined, undefined, nextLogin.cookie)).status).toBe(
      401,
    )
    expect((await request('GET', `/users/${account.id}`, 'managementAdmin')).status).toBe(200)
    const branchLogin = await login(account.email)
    expect(branchLogin.status).toBe(200)
    expect(
      (
        await request('PATCH', `/users/${account.id}`, 'administrator', {
          roleId: systemRoleId,
          isCrossBranch: true,
        })
      ).status,
    ).toBe(200)
    expect(
      (await request('GET', '/auth/me', undefined, undefined, branchLogin.cookie)).status,
    ).toBe(401)
    expect(
      (
        await request('PATCH', `/users/${account.id}`, 'administrator', {
          roleId: basicRoleId,
          branchId,
          isCrossBranch: false,
        })
      ).status,
    ).toBe(200)
  })

  it('preserves every session when a name edit includes unchanged role, branch, access, and status values', async () => {
    const account = await createAccount('unchanged assignment', basicRoleId)
    const loggedIn = await login(account.email)
    expect(loggedIn.status).toBe(200)
    const anotherSession = await addSession(account.id)
    expect(
      (
        await request('PATCH', `/users/${account.id}`, 'managementAdmin', {
          name: 'Updated display name',
          roleId: basicRoleId,
          branchId,
          isCrossBranch: false,
          status: 'Active',
        })
      ).status,
    ).toBe(200)
    expect((await request('GET', '/auth/me', undefined, undefined, loggedIn.cookie)).status).toBe(
      200,
    )
    expect((await request('GET', '/auth/me', undefined, undefined, anotherSession)).status).toBe(
      200,
    )
    const detail = await request<UserDetail>('GET', `/users/${account.id}`, 'managementAdmin')
    expect(detail.body.user).toMatchObject({
      name: 'Updated display name',
      roleId: basicRoleId,
      branchId,
      isCrossBranch: false,
      status: 'Active',
    })
  })

  it('protects self administration and the system role', async () => {
    await expectError(
      'PATCH',
      `/users/${accounts.managementAdmin!.id}`,
      'managementAdmin',
      { status: 'Inactive' },
      409,
      'SELF_ADMIN_CHANGE',
    )
    await expectError(
      'POST',
      `/users/${accounts.managementAdmin!.id}/password`,
      'managementAdmin',
      { password: initialPassword },
      409,
      'SELF_PASSWORD_RESET',
    )
    await expectError(
      'PATCH',
      `/roles/${systemRoleId}`,
      'administrator',
      { description: 'Overwrite administrator' },
      409,
      'SYSTEM_ROLE_LOCKED',
    )
    await expectError(
      'DELETE',
      `/roles/${systemRoleId}`,
      'administrator',
      undefined,
      409,
      'SYSTEM_ROLE_LOCKED',
    )
    await expectError(
      'PATCH',
      `/users/${accounts.administrator!.id}`,
      'globalManager',
      { roleId: basicRoleId },
      403,
      'ADMIN_ROLE_REQUIRED',
    )
    const response = await request(
      'PATCH',
      `/users/${accounts.administrator!.id}`,
      'globalManager',
      { roleId: systemRoleId },
    )
    expect(response.status).toBe(200)
    // Reassigning the identical role does not remove the administrator or revoke
    // its existing session.
    expect((await request('GET', '/auth/me', 'administrator')).status).toBe(200)
    const administrator = await request<UserDetail>(
      'GET',
      `/users/${accounts.administrator!.id}`,
      'globalManager',
    )
    expect(administrator.body.user.status).toBe('Active')
  })

  it('enforces existing role grant ceilings and global assignment scope for edits and deletion', async () => {
    await expectError(
      'PATCH',
      `/roles/${privilegedRoleId}`,
      'managementAdmin',
      { permissions: ['users.read'] },
      403,
      'PERMISSION_ESCALATION',
    )
    await expectError(
      'DELETE',
      `/roles/${privilegedRoleId}`,
      'managementAdmin',
      undefined,
      403,
      'PERMISSION_ESCALATION',
    )
    const restrictedAdminRoles = await request<RoleRecord[]>('GET', '/roles', 'managementAdmin')
    expect(restrictedAdminRoles.body.find((role) => role.id === sharedRoleId)).toMatchObject({
      assignedUserCount: 2,
      canManage: true,
    })
    const globalRoles = await request<RoleRecord[]>('GET', '/roles', 'administrator')
    expect(globalRoles.body.find((role) => role.id === sharedRoleId)).toMatchObject({
      assignedUserCount: 2,
      canManage: true,
    })
    expect(
      (
        await request('PATCH', `/roles/${sharedRoleId}`, 'administrator', {
          description: 'Authorized global edit',
        })
      ).status,
    ).toBe(200)
    await expectError(
      'DELETE',
      `/roles/${sharedRoleId}`,
      'administrator',
      undefined,
      409,
      'ROLE_IN_USE',
    )
  })

  it('creates, edits, audits, and deletes unused custom roles; grant changes revoke assigned sessions', async () => {
    const created = await request<{ id: string }>('POST', '/roles', 'managementAdmin', {
      name: `Managed role ${fixture}`,
      description: 'Account team',
      permissions: ['users.read'],
    })
    expect(created.status).toBe(201)
    const roleId = created.body.id
    const target = await createAccount('role session', roleId)
    expect(
      (
        await request('PATCH', `/roles/${roleId}`, 'managementAdmin', {
          description: 'Updated wording',
        })
      ).status,
    ).toBe(200)
    expect((await request('GET', '/auth/me', undefined, undefined, target.cookie)).status).toBe(200)
    expect(
      (
        await request('PATCH', `/roles/${roleId}`, 'managementAdmin', {
          permissions: ['users.read', 'products.read'],
        })
      ).status,
    ).toBe(200)
    expect((await request('GET', '/auth/me', undefined, undefined, target.cookie)).status).toBe(401)
    const refreshed = await login(target.email)
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.user.permissions.sort()).toEqual(['products.read', 'users.read'])
    const roleDetail = await request<RoleDetail>('GET', `/roles/${roleId}`, 'managementAdmin')
    expect(roleDetail.body.role).toMatchObject({ assignedUserCount: 1, canManage: true })
    expect(roleDetail.body.historyTotal).toBe(3)
    expect(roleDetail.body.history.map((entry) => entry.action)).toContain('created role')
    await expectError(
      'PATCH',
      `/roles/${roleId}`,
      'managementAdmin',
      { permissions: ['reports.export'] },
      403,
      'PERMISSION_ESCALATION',
    )
    await expectError(
      'DELETE',
      `/roles/${roleId}`,
      'managementAdmin',
      undefined,
      409,
      'ROLE_IN_USE',
    )
    expect(
      (await request('PATCH', `/users/${target.id}`, 'managementAdmin', { roleId: basicRoleId }))
        .status,
    ).toBe(200)
    expect((await request('DELETE', `/roles/${roleId}`, 'managementAdmin')).status).toBe(200)
    await expectError(
      'GET',
      `/roles/${roleId}`,
      'managementAdmin',
      undefined,
      404,
      'ROLE_NOT_FOUND',
    )
    const audit = await pool.query(
      "select action from audit_logs where entity_type = 'role' and entity_id = $1 and action = 'deleted role'",
      [roleId],
    )
    expect(audit.rowCount).toBe(1)
  })

  it('gates and paginates real audit history and suppresses unsafe imported fields', async () => {
    const account = await createAccount('history', basicRoleId)
    for (let index = 0; index < 21; index++)
      await pool.query(
        "insert into audit_logs (user_id, branch_id, entity_type, entity_id, action, new_value) values ($1, $2, 'user', $3, 'imported account metadata', $4)",
        [
          accounts.manager!.id,
          branchId,
          account.id,
          {
            name: `Historical name ${index}`,
            password: 'must-not-leak',
            password_hash: 'must-not-leak',
            token: 'must-not-leak',
          },
        ],
      )
    const first = await request<UserDetail>('GET', `/users/${account.id}`, 'managementAdmin')
    expect(first.body.history).toHaveLength(20)
    expect(first.body.historyTotal).toBe(21)
    expect(first.body.historyPageSize).toBe(20)
    expect(JSON.stringify(first.body)).not.toContain('must-not-leak')
    const second = await request<UserDetail>(
      'GET',
      `/users/${account.id}?historyPage=2`,
      'managementAdmin',
    )
    expect(second.body.history).toHaveLength(1)
    expect(second.body.historyPage).toBe(2)
    const withoutAudit = await request<UserDetail>('GET', `/users/${account.id}`, 'noAuditAdmin')
    expect(withoutAudit.body.history).toEqual([])
    expect(withoutAudit.body.historyTotal).toBe(0)
    const roleWithoutAudit = await request<RoleDetail>(
      'GET',
      `/roles/${sharedRoleId}`,
      'noAuditAdmin',
    )
    expect(roleWithoutAudit.body.history).toEqual([])
    expect(roleWithoutAudit.body.historyTotal).toBe(0)
  })

  it('counts concurrent failed attempts atomically and cannot create a session with pre-reset credentials', async () => {
    const account = await createAccount('lockout', basicRoleId)
    const failedLogins = await Promise.all(
      Array.from({ length: 8 }, () => login(account.email, 'incorrect-fixture-password')),
    )
    expect(failedLogins.every((response) => response.status === 401)).toBe(true)
    const locked = await pool.query(
      'select failed_login_attempts, locked_until from users where id = $1',
      [account.id],
    )
    expect(locked.rows[0]?.failed_login_attempts).toBe(8)
    expect(locked.rows[0]?.locked_until).not.toBeNull()
    expect((await login(account.email)).status).toBe(423)
    await pool.query("update users set locked_until = now() - interval '1 second' where id = $1", [
      account.id,
    ])
    await recordFailedLogin(account.id)
    const resetCount = await pool.query(
      'select failed_login_attempts, locked_until from users where id = $1',
      [account.id],
    )
    expect(resetCount.rows[0]).toEqual({ failed_login_attempts: 1, locked_until: null })
    const token = hashSessionToken(createSessionToken())
    const replacementHash = await hashPassword(`Replacement-${randomUUID()}`)
    await pool.query('update users set password_hash = $2 where id = $1', [
      account.id,
      replacementHash,
    ])
    expect(
      await createSession(
        account.id,
        token,
        new Date(Date.now() + 60_000),
        null,
        null,
        passwordHash,
      ),
    ).toBe(false)
    const session = await pool.query('select id from user_sessions where token_hash = $1', [token])
    expect(session.rowCount).toBe(0)
    await pool.query("update users set status = 'Inactive' where id = $1", [account.id])
    expect(
      await createSession(
        account.id,
        token,
        new Date(Date.now() + 60_000),
        null,
        null,
        replacementHash,
      ),
    ).toBe(false)
  })

  it('serializes concurrent administrator deactivations and preserves one active administrator', async () => {
    // Other serial integration files share this disposable database and can
    // leave system-role fixtures behind. Isolate the race to these two actors.
    await pool.query(
      `update users u set status = 'Inactive'
       from roles r
       where r.id = u.role_id and r.is_system = 1 and u.status = 'Active'
         and u.id <> all($1::uuid[])`,
      [[accounts.administrator!.id, accounts.globalManager!.id]],
    )
    const concurrentDeactivations = await Promise.all([
      request<ApiError>('PATCH', `/users/${accounts.administrator!.id}`, 'globalManager', {
        status: 'Inactive',
      }),
      request<ApiError>('PATCH', `/users/${accounts.globalManager!.id}`, 'administrator', {
        status: 'Inactive',
      }),
    ])
    expect(concurrentDeactivations.map(({ status }) => status).sort()).toEqual([200, 409])
    expect(concurrentDeactivations.find(({ status }) => status === 409)?.body.error.code).toBe(
      'LAST_ADMIN_REQUIRED',
    )
    const activeAdministrators = await pool.query<{ count: string }>(
      `select count(*)::text as count from users u join roles r on r.id = u.role_id
       where r.is_system = 1 and u.status = 'Active' and u.deleted_at is null`,
    )
    expect(activeAdministrators.rows[0]?.count).toBe('1')
  })

  it('normalizes legacy branch-access flags without changing account assignments', async () => {
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query('update users set is_cross_branch=1 where id=$1', [
        accounts.crossBranch!.id,
      ])
      await client.query('update users set is_cross_branch=0 where id=$1', [
        accounts.administrator!.id,
      ])
      const migration = await readFile(
        new URL('../../drizzle/0025_admin_only_cross_branch_access.sql', import.meta.url),
        'utf8',
      )
      await client.query(migration)
      const normalized = await client.query<{
        customAccess: number
        customBranchId: string
        administratorAccess: number
        administratorBranchId: string | null
      }>(
        `select custom_user.is_cross_branch as "customAccess",
                custom_user.branch_id::text as "customBranchId",
                admin_user.is_cross_branch as "administratorAccess",
                admin_user.branch_id::text as "administratorBranchId"
         from users custom_user cross join users admin_user
         where custom_user.id=$1 and admin_user.id=$2`,
        [accounts.crossBranch!.id, accounts.administrator!.id],
      )
      expect(normalized.rows[0]).toEqual({
        customAccess: 0,
        customBranchId: branchId,
        administratorAccess: 1,
        administratorBranchId: null,
      })
    } finally {
      try {
        await client.query('rollback')
      } finally {
        client.release()
      }
    }
  })

  it('allows only Administrators to delete another account and retains its audit history', async () => {
    const target = await createAccount('deletion target', basicRoleId)
    const administrator = await createAccount('deletion administrator', systemRoleId, null, true)

    const denied = await request<ApiError>('DELETE', `/users/${target.id}`, 'manager')
    expect(denied.status).toBe(403)

    const unchanged = await pool.query<{ status: string; deletedAt: Date | null }>(
      'select status, deleted_at as "deletedAt" from users where id=$1',
      [target.id],
    )
    expect(unchanged.rows[0]).toEqual({ status: 'Active', deletedAt: null })

    const deleted = await request<{ id: string }>(
      'DELETE',
      `/users/${target.id}`,
      'deletion administrator',
    )
    expect(deleted.status).toBe(200)
    expect(deleted.body.id).toBe(target.id)

    const account = await pool.query<{
      status: string
      deletedAt: Date | null
      deletedBy: string | null
      sessions: number
    }>(
      `select u.status,u.deleted_at as "deletedAt",u.deleted_by::text as "deletedBy",
              (select count(*)::int from user_sessions s where s.user_id=u.id) as sessions
       from users u where u.id=$1`,
      [target.id],
    )
    expect(account.rows[0]).toMatchObject({
      status: 'Inactive',
      deletedBy: administrator.id,
      sessions: 0,
    })
    expect(account.rows[0]?.deletedAt).not.toBeNull()
    expect((await login(target.email)).status).toBe(401)

    const audit = await pool.query<{
      action: string
      oldValue: { status?: string } | null
      newValue: { status?: string; deleted?: boolean; sessionsRevoked?: boolean } | null
    }>(
      `select action,old_value as "oldValue",new_value as "newValue"
       from audit_logs where entity_type='user' and entity_id=$1 and action='deleted user account'`,
      [target.id],
    )
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]).toMatchObject({
      action: 'deleted user account',
      oldValue: { status: 'Active' },
      newValue: { status: 'Inactive', deleted: true, sessionsRevoked: true },
    })

    const detail = await request<ApiError>('GET', `/users/${target.id}`, 'deletion administrator')
    expect(detail.status).toBe(404)
  })

  it('blocks self-deletion and serializes concurrent Administrator deletions', async () => {
    const selfDeletingAdmin = await createAccount(
      'self delete administrator',
      systemRoleId,
      null,
      true,
    )
    await expectError(
      'DELETE',
      `/users/${selfDeletingAdmin.id}`,
      'self delete administrator',
      undefined,
      409,
      'SELF_ACCOUNT_DELETE',
    )

    const firstAdmin = await createAccount('delete race first', systemRoleId, null, true)
    const secondAdmin = await createAccount('delete race second', systemRoleId, null, true)
    await pool.query(
      `update users u set status='Inactive'
       from roles r where r.id=u.role_id and r.is_system=1 and u.status='Active'
         and u.id <> all($1::uuid[])`,
      [[firstAdmin.id, secondAdmin.id]],
    )

    const attempts = await Promise.all([
      request<ApiError>('DELETE', `/users/${secondAdmin.id}`, 'delete race first'),
      request<ApiError>('DELETE', `/users/${firstAdmin.id}`, 'delete race second'),
    ])
    expect(attempts.filter((response) => response.status === 200)).toHaveLength(1)
    expect(
      attempts.filter((response) => response.status === 401 || response.status === 409),
    ).toHaveLength(1)

    const survivors = await pool.query<{ count: string }>(
      `select count(*)::text as count from users u join roles r on r.id=u.role_id
       where r.is_system=1 and u.status='Active' and u.deleted_at is null`,
    )
    expect(survivors.rows[0]?.count).toBe('1')
  })
})
