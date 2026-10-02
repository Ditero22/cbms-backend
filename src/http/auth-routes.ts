import { Router } from 'express'
import { z } from 'zod'
import { env } from '@/config/env.js'
import { sessionLifetimeMs, sessionCookieName } from '@/shared/security/session.js'
import { AppError } from '@/shared/errors/AppError.js'
import { signIn, signOut } from '@/features/auth/auth.service.js'
import { authenticate } from './auth.js'
import { accessCookieName } from '@/shared/security/access-token.js'
import { accessTokenForSession, refreshAuthentication } from '@/features/auth/refresh.service.js'
import { revokeUserSessions } from '@/features/auth/auth.repository.js'

const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
})

const sessionCookieOptions = {
  httpOnly: true,
  secure: env.isProduction,
  sameSite: 'lax' as const,
  path: '/api/v1',
  ...(env.cookieDomain ? { domain: env.cookieDomain } : {}),
}

export const authRouter = Router()

authRouter.post('/login', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Enter a valid email and password.',
      parsed.error.flatten(),
    )
  }

  const session = await signIn(parsed.data.email, parsed.data.password, {
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  })

  if (env.authMode === 'jwt') {
    const accessToken = await accessTokenForSession(session.token)
    res.cookie(accessCookieName, accessToken, {
      ...sessionCookieOptions,
      maxAge: env.jwt.ttlSeconds * 1000,
    })
  }

  res.cookie(sessionCookieName, session.token, {
    ...sessionCookieOptions,
    maxAge: sessionLifetimeMs,
  })
  res.json({ user: session.user })
})

authRouter.get('/me', authenticate, (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({ user: req.user })
})

authRouter.post('/refresh', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const origin = req.get('origin')
  if (!origin || !env.corsOrigins.has(origin))
    throw new AppError(
      403,
      'ORIGIN_NOT_ALLOWED',
      'This website is not allowed to refresh authentication.',
    )
  if (env.authMode !== 'jwt') throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  const previous = req.cookies?.[sessionCookieName]
  if (typeof previous !== 'string' || previous.length > 256)
    throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  const next = await refreshAuthentication(previous)
  res.cookie(sessionCookieName, next.token, { ...sessionCookieOptions, expires: next.expiresAt })
  res.cookie(accessCookieName, next.accessToken, {
    ...sessionCookieOptions,
    maxAge: env.jwt.ttlSeconds * 1000,
  })
  res.status(204).end()
})

authRouter.post('/logout', async (req, res) => {
  const token = req.cookies?.[sessionCookieName] as string | undefined
  await signOut(token)
  res.clearCookie(sessionCookieName, sessionCookieOptions)
  res.clearCookie(accessCookieName, sessionCookieOptions)
  res.status(204).end()
})

authRouter.post('/logout-all', authenticate, async (req, res) => {
  if (!req.user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  await revokeUserSessions(req.user.id)
  res.clearCookie(sessionCookieName, sessionCookieOptions)
  res.clearCookie(accessCookieName, sessionCookieOptions)
  res.status(204).end()
})
