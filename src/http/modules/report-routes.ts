import { Router } from 'express'
import { reportToCsv } from '@/features/reports/reports.csv.js'
import { generateReport } from '@/features/reports/reports.service.js'
import { reportOptionsQuerySchema, reportQuerySchema } from '@/features/reports/reports.schemas.js'
import { AppError } from '@/shared/errors/AppError.js'
import { getReportOptions } from '@/features/reports/report-options.repository.js'

export const reportRouter = Router()
reportRouter.get('/reports/options', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')

  const parsed = reportOptionsQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Choose a valid branch filter.',
      parsed.error.flatten(),
    )
  }
  res.json(await getReportOptions(user, parsed.data.branchId))
})

reportRouter.get('/reports/data', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')

  const parsed = reportQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Choose a report and a valid date range.',
      parsed.error.flatten(),
    )
  }

  res.json(await generateReport(parsed.data, user))
})

reportRouter.get('/reports/export', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')

  const parsed = reportQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Choose a report and a valid date range.',
      parsed.error.flatten(),
    )
  }

  const report = await generateReport(parsed.data, user, true, {
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })
  const period = ['inventory-health', 'customer-balances', 'fleet-status'].includes(
    parsed.data.report,
  )
    ? 'current'
    : `${parsed.data.dateFrom}-to-${parsed.data.dateTo}`
  const filename = `cbms-${parsed.data.report}-${period}.csv`
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(reportToCsv(report))
})
