import { AppError } from '@/shared/errors/AppError.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { verifyPassword } from '@/shared/security/password.js'
import {
  createSessionToken,
  hashSessionToken,
  sessionLifetimeMs,
} from '@/shared/security/session.js'
import * as authRepository from './auth.repository.js'
import { verifyAccessToken } from '@/shared/security/access-token.js'

type LoginRequestContext = {
  ipAddress: string | null
  userAgent: string | null
}

export async function signIn(email: string, password: string, context: LoginRequestContext) {
  const account = await authRepository.findAccountByEmail(email.trim().toLowerCase())

  if (!account || account.status !== 'Active') {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.')
  }
  if (account.locked_until && new Date(account.locked_until).getTime() > Date.now()) {
    throw new AppError(
      423,
      'ACCOUNT_LOCKED',
      'This account is temporarily locked. Try again later.',
    )
  }

  const passwordMatches = await verifyPassword(password, account.password_hash)
  if (!passwordMatches) {
    await authRepository.recordFailedLogin(account.id)
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.')
  }

  const token = createSessionToken()
  const expiresAt = new Date(Date.now() + sessionLifetimeMs)
  const sessionCreated = await authRepository.createSession(
    account.id,
    hashSessionToken(token),
    expiresAt,
    context.ipAddress,
    context.userAgent,
    account.password_hash,
  )
  if (!sessionCreated)
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.')

  return {
    token,
    user: toAuthenticatedUser(account),
  }
}

export async function authenticateSession(token: string): Promise<AuthenticatedUser> {
  const session = await authRepository.findSessionByTokenHash(hashSessionToken(token))
  return resolveSession(session)
}

export async function authenticateAccessToken(token: string): Promise<AuthenticatedUser> {
  const claims = await verifyAccessToken(token)
  const session = await authRepository.findSessionById(claims.sid)
  if (session?.id !== claims.sub) throw new AppError(401, 'SESSION_EXPIRED', 'Sign in again.')
  return resolveSession(session)
}

function resolveSession(session: authRepository.AuthSession | undefined): AuthenticatedUser {
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
    throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Sign in again.')
  }

  void authRepository.updateSessionLastSeen(session.sessionId).catch(() => undefined)

  return {
    id: session.id,
    name: session.name,
    email: session.email,
    branchId: session.branchId,
    branch: session.branch,
    isCrossBranch: session.isCrossBranch === 1,
    role: session.role,
    permissions: session.permissions,
  }
}

export async function signOut(token?: string) {
  if (token) await authRepository.deleteSessionByTokenHash(hashSessionToken(token))
}

function toAuthenticatedUser(account: authRepository.AuthAccount): AuthenticatedUser {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    role: account.role,
    branchId: account.branch_id,
    branch: account.branch,
    isCrossBranch: account.is_cross_branch === 1 && account.is_system_role === 1,
    permissions: account.permissions,
  }
}
