import { describe, expect, it } from 'vitest'
import { reportToCsv } from '@/features/reports/reports.csv.js'

describe('reportToCsv', () => {
  it('quotes cells and protects spreadsheet formulas', () => {
    const csv = reportToCsv({
      title: 'Approved expenses',
      columns: ['Category', 'Total'],
      rows: [{ Category: '=HYPERLINK("https://example.invalid")', Total: '1,200.00' }],
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
      generatedAt: '2026-02-01T00:00:00.000Z',
    })

    expect(csv).toBe(
      '\uFEFF"Category","Total"\r\n"\'=HYPERLINK(""https://example.invalid"")","1,200.00"',
    )
  })

  it('exports an empty report with its headers', () => {
    const csv = reportToCsv({
      title: 'Inventory health',
      columns: ['Branch', 'Out of stock'],
      rows: [],
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
      generatedAt: '2026-02-01T00:00:00.000Z',
    })

    expect(csv).toBe('\uFEFF"Branch","Out of stock"')
  })

  it('protects spreadsheet formulas after a leading newline', () => {
    const csv = reportToCsv({
      title: 'Expenses',
      columns: ['Category'],
      rows: [{ Category: '\n=1+1' }],
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
      generatedAt: '2026-02-01T00:00:00.000Z',
    })

    expect(csv).toContain('"\'\n=1+1"')
  })
})
