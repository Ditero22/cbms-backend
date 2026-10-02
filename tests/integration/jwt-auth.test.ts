import { randomBytes, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '@/app.js'
import { env } from '@/config/env.js'
import { pool } from '@/database/client.js'
import { hashPassword } from '@/shared/security/password.js'
import { authenticateAccessToken } from '@/features/auth/auth.service.js'
import { accessCookieName } from '@/shared/security/access-token.js'

const fixture = randomUUID()
const email = `jwt-${fixture}@example.invalid`
const password = randomBytes(32).toString('base64url') + 'a1!'
const origin = 'http://localhost:5199'
const previousMode = env.authMode
const previousSecret = env.jwt.secret
let userId: string
let roleId: string
let server: Server
let base: string
function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ')
}
async function login() {
  return fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
}
function request(path: string, cookies: string, method = 'GET') {
  return fetch(`${base}${path}`, { method, headers: { Origin: origin, Cookie: cookies } })
}
function access(cookies: string) {
  return cookies
    .split('; ')
    .find((v) => v.startsWith(accessCookieName + '='))!
    .slice(accessCookieName.length + 1)
}

beforeAll(async () => {
  env.authMode = 'jwt'
  env.jwt.secret = randomBytes(48).toString('base64url')
  env.corsOrigins.add(origin)
  roleId = (await pool.query('insert into roles(name) values($1) returning id', [`JWT ${fixture}`]))
    .rows[0].id
  userId = (
    await pool.query(
      'insert into users(name,email,password_hash,role_id) values($1,$2,$3,$4) returning id',
      ['JWT fixture', email, await hashPassword(password), roleId],
    )
  ).rows[0].id
  server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server unavailable')
  base = `http://127.0.0.1:${address.port}/api/v1`
})
afterAll(async () => {
  env.authMode = previousMode
  env.jwt.secret = previousSecret
  env.corsOrigins.delete(origin)
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  await pool.query('delete from users where id=$1', [userId])
  await pool.query('delete from roles where id=$1', [roleId])
})

describe('JWT session and refresh lifecycle', () => {
  it('logs in with HttpOnly access/refresh cookies and validates the session', async () => {
    const response = await login()
    expect(response.status).toBe(200)
    expect(
      response.headers
        .getSetCookie()
        .every((v) => v.includes('HttpOnly') && v.includes('SameSite=Lax')),
    ).toBe(true)
    expect((await request('/auth/me', cookie(response))).status).toBe(200)
  })
  it('rejects incorrect credentials', async () => {
    const response = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'invalid' }),
    })
    expect(response.status).toBe(401)
  })
  it('refreshes, rotates the credential, and detects reuse outside the concurrency window', async () => {
    const original = cookie(await login())
    const refreshed = await request('/auth/refresh', original, 'POST')
    expect(refreshed.status).toBe(204)
    const next = cookie(refreshed)
    expect(next).not.toBe(original)
    expect((await request('/auth/me', next)).status).toBe(200)
    expect((await request('/auth/refresh', original, 'POST')).status).toBe(409)
    await pool.query(
      "update used_refresh_tokens set used_at=now()-interval '10 seconds' where session_id in (select id from user_sessions where user_id=$1)",
      [userId],
    )
    expect((await request('/auth/refresh', original, 'POST')).status).toBe(401)
    expect((await request('/auth/me', next)).status).toBe(401)
  })
  it('logout immediately revokes an otherwise valid JWT', async () => {
    const credentials = cookie(await login())
    expect((await request('/auth/logout', credentials, 'POST')).status).toBe(204)
    expect((await request('/auth/me', credentials)).status).toBe(401)
    expect((await request('/auth/refresh', credentials, 'POST')).status).toBe(401)
  })
  it('rejects expired refresh sessions', async () => {
    const credentials = cookie(await login())
    await pool.query(
      "update user_sessions set expires_at=now()-interval '1 minute' where user_id=$1",
      [userId],
    )
    expect((await request('/auth/refresh', credentials, 'POST')).status).toBe(401)
    expect((await request('/auth/me', credentials)).status).toBe(401)
  })
  it('deactivation takes effect immediately', async () => {
    const credentials = cookie(await login())
    await pool.query("update users set status='Inactive' where id=$1", [userId])
    expect((await request('/auth/me', credentials)).status).toBe(401)
    expect((await request('/auth/refresh', credentials, 'POST')).status).toBe(401)
    await pool.query("update users set status='Active' where id=$1", [userId])
  })
  it('uses current grants rather than stale JWT claims', async () => {
    const token = access(cookie(await login()))
    expect((await authenticateAccessToken(token)).permissions).not.toContain('orders.read')
    await pool.query('insert into role_permissions(role_id,permission_key) values($1,$2)', [
      roleId,
      'orders.read',
    ])
    expect((await authenticateAccessToken(token)).permissions).toContain('orders.read')
    await pool.query('delete from role_permissions where role_id=$1', [roleId])
    expect((await authenticateAccessToken(token)).permissions).not.toContain('orders.read')
  })
  it('requires a trusted Origin on refresh', async () => {
    const credentials = cookie(await login())
    const response = await fetch(`${base}/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: credentials },
    })
    expect(response.status).toBe(403)
  })
  it('logout-all revokes every device session', async () => {
    const first = cookie(await login())
    const second = cookie(await login())
    expect((await request('/auth/logout-all', first, 'POST')).status).toBe(204)
    expect((await request('/auth/me', first)).status).toBe(401)
    expect((await request('/auth/me', second)).status).toBe(401)
  })
  it('role and branch reassignment take effect without trusting the old JWT', async () => {
    const token = access(cookie(await login()))
    const branch = (
      await pool.query('insert into branches(name,code) values($1,$2) returning id', [
        `JWT branch ${fixture}`,
        `JWT-${fixture}`,
      ])
    ).rows[0].id
    const role = (
      await pool.query('insert into roles(name) values($1) returning id', [
        `JWT reassigned ${fixture}`,
      ])
    ).rows[0].id
    try {
      await pool.query('update users set branch_id=$2,role_id=$3,is_cross_branch=1 where id=$1', [
        userId,
        branch,
        role,
      ])
      const user = await authenticateAccessToken(token)
      expect(user.branchId).toBe(branch)
      expect(user.role).toBe(`JWT reassigned ${fixture}`)
      expect(user.isCrossBranch).toBe(false)
    } finally {
      await pool.query('update users set branch_id=null,role_id=$2,is_cross_branch=0 where id=$1', [
        userId,
        roleId,
      ])
      await pool.query('delete from roles where id=$1', [role])
      await pool.query('delete from branches where id=$1', [branch])
    }
  })
})
