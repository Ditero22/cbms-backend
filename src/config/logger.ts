import pino from 'pino'
import { env } from './env.js'

export const logger = pino({
  level: env.nodeEnv === 'test' ? 'silent' : env.logLevel,
  redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'],
})
