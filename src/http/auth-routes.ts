import { Router } from 'express'
import { z } from 'zod'
import { env } from '@/config/env.js'
import { sessionLifetimeMs, sessionCookieName } from '@/shared/security/session.js'
import { AppError } from '@/shared/errors/AppError.js'
import { signIn, signOut } from '@/features/auth/auth.service.js'
import { authenticate } from './auth.js'

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

  res.cookie(sessionCookieName, session.token, {
    ...sessionCookieOptions,
    maxAge: sessionLifetimeMs,
  })
  res.json({ user: session.user })
})

authRouter.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user })
})

authRouter.post('/logout', async (req, res) => {
  const token = req.cookies?.[sessionCookieName] as string | undefined
  await signOut(token)
  res.clearCookie(sessionCookieName, sessionCookieOptions)
  res.status(204).end()
})
