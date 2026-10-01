import type { Server } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { AppError } from '@/shared/errors/AppError.js'

const { logs } = vi.hoisted(() => ({ logs: [] as string[] }))
vi.mock('@/config/logger.js', async () => {
  const { default: pino } = await import('pino')
  return {
    logger: pino({ level: 'info' }, { write: (message: string) => logs.push(message) }),
  }
})

let server: Server
let apiUrl: string

beforeAll(async () => {
  process.env.NODE_ENV = 'test'
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/cbms_test'
  process.env.SESSION_SECRET = 'test-only-session-secret-with-32-characters'
  const [{ configureRequestMiddleware }, { errorHandler }] = await Promise.all([
    import('@/http/middleware.js'),
    import('@/http/error-handler.js'),
  ])
  const app = express()
  configureRequestMiddleware(app)
  app.get('/diagnostics', (_req, res) => {
    const error = new Error('Failed query: synthetic-private-query', {
      cause: Object.assign(new Error('synthetic-private-postgres-message'), {
        detail: 'Key (email)=(synthetic-private-person@example.invalid) already exists.',
        parameters: ['synthetic-private-parameter'],
      }),
    })
    // Exercise the pino-http completion serializer as well as the application handler.
    res.err = error
    throw error
  })
  app.get('/service-unavailable', () => {
    throw new AppError(
      503,
      'DATABASE_UNAVAILABLE',
      'The database service is temporarily unavailable.',
    )
  })
  app.use(errorHandler)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Diagnostic test API did not start.')
  apiUrl = `http://127.0.0.1:${address.port}`
})

beforeEach(() => logs.splice(0))

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
})

it('omits private query, cookie, and nested database details from every HTTP error log', async () => {
  const response = await fetch(`${apiUrl}/diagnostics?search=synthetic-private-search`, {
    headers: { cookie: 'synthetic-private-cookie', 'x-request-id': 'diagnostic-request-001' },
  })

  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
    requestId: 'diagnostic-request-001',
  })
  expect(logs).toHaveLength(2)
  expect(logs.join('')).not.toContain('synthetic-private')
  const records = logs.map((line) => JSON.parse(line))
  expect(records).toContainEqual(
    expect.objectContaining({
      errorType: 'InternalError',
      errorCode: 'INTERNAL_ERROR',
      requestId: 'diagnostic-request-001',
    }),
  )
  expect(records).toContainEqual(
    expect.objectContaining({
      req: { method: 'GET', pathname: '/diagnostics' },
      res: { statusCode: 500 },
      err: { errorType: 'InternalError', errorCode: 'INTERNAL_ERROR' },
    }),
  )
})

it('preserves the service status and public response while logging a safe classification', async () => {
  const response = await fetch(`${apiUrl}/service-unavailable`)

  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({
    error: {
      code: 'DATABASE_UNAVAILABLE',
      message: 'The database service is temporarily unavailable.',
    },
  })
  expect(logs.map((line) => JSON.parse(line))).toContainEqual(
    expect.objectContaining({ errorType: 'ApplicationError', errorCode: 'DATABASE_UNAVAILABLE' }),
  )
})
