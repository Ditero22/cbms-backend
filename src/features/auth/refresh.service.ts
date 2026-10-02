import { AppError } from '@/shared/errors/AppError.js'
import { createSessionToken, hashSessionToken } from '@/shared/security/session.js'
import { issueAccessToken } from '@/shared/security/access-token.js'
import { findSessionById, findSessionByTokenHash } from './auth.repository.js'
import { rotateRefreshCredential } from './refresh.repository.js'

export async function accessTokenForSession(refresh: string) {
  const session = await findSessionByTokenHash(hashSessionToken(refresh))
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) throw expired()
  return issueAccessToken(session.id, session.sessionId)
}

export async function refreshAuthentication(previous: string) {
  const token = createSessionToken()
  const result = await rotateRefreshCredential(hashSessionToken(previous), hashSessionToken(token))
  if (result.kind === 'concurrent')
    throw new AppError(409, 'REFRESH_CONCURRENT', 'Authentication is being refreshed. Try again.')
  if (result.kind !== 'rotated') throw expired()
  const session = await findSessionById(result.sessionId)
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) throw expired()
  return {
    token,
    accessToken: await issueAccessToken(session.id, session.sessionId),
    expiresAt: new Date(session.expiresAt),
  }
}

function expired() {
  return new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Sign in again.')
}
