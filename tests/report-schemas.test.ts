import { describe, expect, it } from 'vitest'
import { reportQuerySchema } from '@/features/reports/reports.schemas.js'

describe('reportQuerySchema', () => {
  it('accepts a supported report and bounded date range', () => {
    expect(
      reportQuerySchema.safeParse({
        report: 'sales-by-branch',
        dateFrom: '2026-01-01',
        dateTo: '2026-12-31',
      }).success,
    ).toBe(true)
  })

  it('rejects unsupported report types and malformed dates', () => {
    expect(
      reportQuerySchema.safeParse({
        report: 'payroll-register',
        dateFrom: 'yesterday',
        dateTo: '2026-01-01',
      }).success,
    ).toBe(false)
  })

  it('rejects reversed dates and date ranges longer than one year', () => {
    expect(
      reportQuerySchema.safeParse({
        report: 'approved-expenses',
        dateFrom: '2026-02-01',
        dateTo: '2026-01-31',
      }).success,
    ).toBe(false)
    expect(
      reportQuerySchema.safeParse({
        report: 'inventory-health',
        dateFrom: '2025-01-01',
        dateTo: '2026-01-03',
      }).success,
    ).toBe(false)
  })
})
