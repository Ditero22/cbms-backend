import { createHash, randomBytes } from 'node:crypto'

export const sessionCookieName = 'cbms_session'
export const sessionLifetimeMs = 1000 * 60 * 60 * 12

export function createSessionToken() {
  return randomBytes(32).toString('base64url')
}

export function hashSessionToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}
