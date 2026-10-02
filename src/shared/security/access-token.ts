import { SignJWT, jwtVerify } from 'jose'
import { z } from 'zod'
import { env } from '@/config/env.js'
import { AppError } from '@/shared/errors/AppError.js'

export const accessCookieName = 'cbms_access'
const claimsSchema = z.object({ sub: z.uuid(), sid: z.uuid() })
const key = () => new TextEncoder().encode(env.jwt.secret)

export async function issueAccessToken(userId: string, sessionId: string) {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(env.jwt.issuer)
    .setAudience(env.jwt.audience)
    .setIssuedAt()
    .setExpirationTime(`${env.jwt.ttlSeconds}s`)
    .sign(key())
}

export async function verifyAccessToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, key(), {
      algorithms: ['HS256'],
      typ: 'JWT',
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
      maxTokenAge: env.jwt.ttlSeconds,
      requiredClaims: ['sub', 'sid', 'iat', 'exp'],
    })
    return claimsSchema.parse(payload)
  } catch {
    throw new AppError(401, 'ACCESS_TOKEN_INVALID', 'Your authentication needs to be refreshed.')
  }
}
