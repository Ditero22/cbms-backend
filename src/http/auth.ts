import type { NextFunction, Request, Response } from 'express'
import { AppError } from '@/shared/errors/AppError.js'
import { sessionCookieName } from '@/shared/security/session.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { authenticateSession } from '@/features/auth/auth.service.js'

export type { AuthenticatedUser } from '@/shared/types/auth.js'

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser
      requestId?: string
    }
  }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[sessionCookieName] as string | undefined
    if (!token) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')

    req.user = await authenticateSession(token)
    next()
  } catch (error) {
    next(error)
  }
}

export function requirePermission(permission: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.'))
    if (!req.user.permissions.includes(permission)) {
      return next(new AppError(403, 'FORBIDDEN', 'You do not have permission to do this.'))
    }
    next()
  }
}
