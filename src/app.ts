import express from 'express'
import { authRouter } from './http/auth-routes.js'
import { errorHandler } from './http/error-handler.js'
import { configureRequestMiddleware, authLimiter, generalLimiter } from './http/middleware.js'
import { moduleRouter } from './http/module-routes.js'
import { systemRouter } from './http/system-routes.js'
import { AppError } from './shared/errors/AppError.js'

const app = express()

configureRequestMiddleware(app)
app.use(systemRouter)
app.use('/api/v1', generalLimiter)
app.use('/api/v1/auth', authLimiter, authRouter)
app.use('/api/v1', moduleRouter)
app.use((_req, _res, next) =>
  next(new AppError(404, 'NOT_FOUND', 'The requested endpoint does not exist.')),
)
app.use(errorHandler)

export { app }
export default app
