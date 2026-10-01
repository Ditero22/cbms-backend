import type { ReportResult } from './reports.repository.js'

function safeCsvCell(value: string) {
  const protectedValue = /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value
  return `"${protectedValue.replaceAll('"', '""')}"`
}

export function reportToCsv(report: ReportResult) {
  const lines = [
    report.columns.map(safeCsvCell).join(','),
    ...report.rows.map((row) =>
      report.columns.map((column) => safeCsvCell(row[column] ?? '')).join(','),
    ),
  ]

  return `\uFEFF${lines.join('\r\n')}`
}
