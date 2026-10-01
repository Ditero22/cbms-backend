import { Router } from 'express'
import { assertDatabaseReady } from '@/database/readiness.js'

export const systemRouter = Router()

systemRouter.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'cbms-api' }))

systemRouter.get('/api/ready', async (_req, res) => {
  await assertDatabaseReady()
  res.json({ status: 'ready', service: 'cbms-api' })
})
