import { randomBytes, randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test')
vi.stubEnv('SESSION_SECRET', 'unit-test-session-secret-not-for-deployment')
vi.stubEnv('JWT_ACCESS_SECRET', randomBytes(48).toString('base64url'))
const { env } = await import('@/config/env.js')
const { issueAccessToken, verifyAccessToken } = await import('@/shared/security/access-token.js')
const user = randomUUID()
const session = randomUUID()
let valid: string
beforeAll(async () => {
  valid = await issueAccessToken(user, session)
})

describe('access JWT validation', () => {
  it('accepts a signed minimal identity and session binding', async () => {
    expect(await verifyAccessToken(valid)).toEqual({ sub: user, sid: session })
    const payload = JSON.parse(Buffer.from(valid.split('.')[1], 'base64url').toString())
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sid', 'sub'])
  })
  it.each([
    'malformed',
    'tampered',
    'wrong signature',
    'expired',
    'wrong issuer',
    'wrong audience',
    'missing expiry',
  ])('rejects %s tokens', async (scenario) => {
    let token: string
    if (scenario === 'malformed') token = 'not-a-jwt'
    else if (scenario === 'tampered') {
      const parts = valid.split('.')
      parts[1] = Buffer.from(JSON.stringify({ sub: randomUUID(), sid: session })).toString(
        'base64url',
      )
      token = parts.join('.')
    } else {
      let jwt = new SignJWT({ sid: session })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(user)
        .setIssuedAt()
        .setIssuer(scenario === 'wrong issuer' ? 'wrong' : env.jwt.issuer)
        .setAudience(scenario === 'wrong audience' ? 'wrong' : env.jwt.audience)
      if (scenario !== 'missing expiry')
        jwt = jwt.setExpirationTime(
          scenario === 'expired' ? Math.floor(Date.now() / 1000) - 1 : '10m',
        )
      token = await jwt.sign(
        scenario === 'wrong signature' ? randomBytes(48) : new TextEncoder().encode(env.jwt.secret),
      )
    }
    await expect(verifyAccessToken(token)).rejects.toMatchObject({ status: 401 })
  })
})
