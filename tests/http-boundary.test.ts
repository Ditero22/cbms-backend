import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/config/env.js', () => ({
  env: {
    nodeEnv: 'test',
    trustProxy: false,
    isProduction: false,
    authMode: 'session',
    corsOrigins: new Set(['http://cbms.test']),
    rateLimitWindowMs: 60_000,
    rateLimitMax: 2,
    authRateLimitMax: 2,
  },
}))

import { errorHandler } from '@/http/error-handler.js'
import { authLimiter, configureRequestMiddleware, generalLimiter } from '@/http/middleware.js'
import { AppError } from '@/shared/errors/AppError.js'

let server: Server
let baseUrl: string

beforeAll(async () => {
  const app = express()
  configureRequestMiddleware(app)
  app.get('/general', generalLimiter, (_req, res) => res.json({ ok: true }))
  app.get('/auth', authLimiter, (_req, res) => res.json({ ok: true }))
  app.post('/body', (_req, res) => res.json({ ok: true }))
  app.get('/proof', (_req, _res, next) =>
    next(new AppError(413, 'PROOF_TOO_LARGE', 'Proof files must be at most 10 MB.')),
  )
  app.get('/internal', (_req, _res, next) =>
    next(Object.assign(new Error('synthetic private internal detail'), { status: 302 })),
  )
  app.use(errorHandler)
  server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

describe('HTTP boundary error contract', () => {
  it.each(['/general', '/auth'])(
    '%s returns correlated JSON and retry headers on throttling',
    async (path) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const allowed = await fetch(`${baseUrl}${path}`)
        expect(allowed.status).toBe(200)
        await allowed.text()
      }
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { 'x-request-id': 'qa-throttle-request' },
      })
      expect(response.status).toBe(429)
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toEqual({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' },
        requestId: 'qa-throttle-request',
      })
    },
  )

  it('correlates malformed JSON without returning submitted content', async () => {
    const response = await fetch(`${baseUrl}/body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'qa-invalid-json' },
      body: '{"synthetic-private-input":',
    })
    expect(response.status).toBe(400)
    expect(response.headers.get('x-request-id')).toBe('qa-invalid-json')
    expect(await response.json()).toEqual({
      error: { code: 'INVALID_REQUEST', message: 'The request body is invalid.' },
      requestId: 'qa-invalid-json',
    })
  })

  it('uses a request-size explanation for the JSON limit', async () => {
    const response = await fetch(`${baseUrl}/body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'a'.repeat(1024 * 1024) }),
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request exceeds the allowed size limit.' },
      requestId: expect.any(String),
    })
  })

  it('preserves domain-specific upload errors', async () => {
    const response = await fetch(`${baseUrl}/proof`)
    expect(response.status).toBe(413)
    expect((await response.json()).error).toEqual({
      code: 'PROOF_TOO_LARGE',
      message: 'Proof files must be at most 10 MB.',
    })
  })

  it('correlates forbidden origins and replaces invalid request IDs', async () => {
    const response = await fetch(`${baseUrl}/body`, {
      method: 'POST',
      headers: { origin: 'https://foreign.invalid', 'x-request-id': 'bad' },
    })
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.error.code).toBe('ORIGIN_NOT_ALLOWED')
    expect(body.requestId).toMatch(/^[a-f\d-]{36}$/)
    expect(response.headers.get('x-request-id')).toBe(body.requestId)
  })

  it('does not trust arbitrary status properties on unexpected exceptions', async () => {
    const response = await fetch(`${baseUrl}/internal`, { redirect: 'manual' })
    expect(response.status).toBe(500)
    expect((await response.json()).error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    })
  })
})
