import { Router } from 'express'
import { getDashboardSummary } from '@/features/dashboard/dashboard.service.js'
import { AppError } from '@/shared/errors/AppError.js'

export const dashboardRouter = Router()

dashboardRouter.get('/dashboard/summary', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')

  res.json(await getDashboardSummary(user))
})
