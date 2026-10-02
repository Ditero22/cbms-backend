import { randomUUID } from 'node:crypto'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type Express } from 'express'
import { rateLimit } from 'express-rate-limit'
import helmet from 'helmet'
import { pinoHttp } from 'pino-http'
import { env } from '@/config/env.js'
import { logger } from '@/config/logger.js'
import { AppError } from '@/shared/errors/AppError.js'
import { errorDiagnostics, requestDiagnostics } from '@/shared/diagnostics.js'

export const generalLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  limit: env.rateLimitMax,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})

export const authLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  limit: env.authRateLimitMax,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})

export function configureRequestMiddleware(app: Express) {
  if (env.trustProxy) app.set('trust proxy', env.trustProxy)
  app.disable('x-powered-by')
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: env.isProduction,
    }),
  )
  app.use(
    cors({
      credentials: true,
      origin(origin, callback) {
        if (!origin || env.corsOrigins.has(origin)) return callback(null, true)
        callback(
          new AppError(403, 'ORIGIN_NOT_ALLOWED', 'This website is not allowed to access the API.'),
        )
      },
    }),
  )
  app.use(express.json({ limit: '1mb', type: 'application/json' }))
  app.use(cookieParser())
  app.use((req, _res, next) => {
    if (env.authMode === 'jwt' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin')
      if (!origin || !env.corsOrigins.has(origin)) {
        return next(
          new AppError(
            403,
            'ORIGIN_NOT_ALLOWED',
            'This website is not allowed to change workspace data.',
          ),
        )
      }
    }
    next()
  })
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const candidate = req.headers['x-request-id']
        const id =
          typeof candidate === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(candidate)
            ? candidate
            : randomUUID()
        res.setHeader('x-request-id', id)
        return id
      },
      customProps: (req) => ({ requestId: String(req.id) }),
      wrapSerializers: false,
      serializers: {
        req: requestDiagnostics,
        res: (res) => ({ statusCode: res.statusCode }),
        err: errorDiagnostics,
      },
    }),
  )
  app.use((req, _res, next) => {
    req.requestId = String(req.id)
    next()
  })
}
