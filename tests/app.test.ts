import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { AppError } from '@/shared/errors/AppError.js'

const { checkReadiness } = vi.hoisted(() => ({ checkReadiness: vi.fn() }))
vi.mock('@/database/readiness.js', () => ({ assertDatabaseReady: checkReadiness }))

let server: Server
let apiUrl: string
let closePool: (() => Promise<void>) | undefined

beforeAll(async () => {
  process.env.NODE_ENV = 'test'
  process.env.DATABASE_URL = 'postgresql://cbms:cbms_dev_only@127.0.0.1:5432/cbms_test'
  process.env.SESSION_SECRET = 'test-only-session-secret-with-32-characters'
  process.env.CORS_ORIGINS = 'http://localhost:5173'
  const [{ default: app }, database] = await Promise.all([
    import('@/app.js'),
    import('@/database/client.js'),
  ])
  closePool = () => database.pool.end()
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test API did not start.')
  apiUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  await closePool?.()
})

describe('HTTP API', () => {
  it('serves a health response without requiring the database', async () => {
    const response = await fetch(`${apiUrl}/api/health`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', service: 'cbms-api' })
    expect(checkReadiness).not.toHaveBeenCalled()
  })

  it('reports readiness only after the database and migration check succeeds', async () => {
    checkReadiness.mockResolvedValueOnce(undefined)
    const response = await fetch(`${apiUrl}/api/ready`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'ready', service: 'cbms-api' })
    expect(checkReadiness).toHaveBeenCalledTimes(1)
  })

  it('returns a structured service-unavailable response for pending migrations', async () => {
    checkReadiness.mockRejectedValueOnce(
      new AppError(
        503,
        'DATABASE_MIGRATIONS_REQUIRED',
        'The database needs an application update.',
      ),
    )
    const response = await fetch(`${apiUrl}/api/ready`)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'DATABASE_MIGRATIONS_REQUIRED' },
      requestId: expect.any(String),
    })
  })

  it('keeps authenticated dashboard access protected while the API is reachable', async () => {
    const response = await fetch(`${apiUrl}/api/v1/dashboard/summary`)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'AUTH_REQUIRED' } })
  })

  it('rejects malformed login payloads before attempting database access', async () => {
    const response = await fetch(`${apiUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: '' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
  })
})
