import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { requireReportAccess } from './reports.access.js'
import type { ReportQuery } from './reports.schemas.js'
import { queryReport, recordReportExport } from './reports.repository.js'
import type { ReportResult } from './reports.repository.js'
import { queryCustomerPaymentReport } from '@/features/payments/payment-reports.repository.js'
import { queryFleetReport } from './fleet-reports.repository.js'
import { AppError } from '@/shared/errors/AppError.js'

type ReportContext = {
  ipAddress: string | null
  requestId: string | null
}

export async function generateReport(
  input: ReportQuery,
  user: AuthenticatedUser,
  forExport = false,
  context?: ReportContext,
): Promise<ReportResult> {
  const assignedBranchId = requireReportAccess(user, forExport)
  const branchId = user.isCrossBranch ? input.branchId : assignedBranchId
  const domainPermission = input.report.startsWith('customer-')
    ? 'payments.read'
    : input.report === 'driver-allowances'
      ? 'driver-allowances.read'
      : input.report === 'fleet-maintenance'
        ? 'vehicles.maintenance'
        : input.report === 'fleet-assignments'
          ? 'vehicles.assign'
          : input.report === 'fleet-status'
            ? 'vehicles.read'
            : null
  if (domainPermission && !user.permissions.includes(domainPermission))
    throw new AppError(403, 'FORBIDDEN', 'Your role cannot view this report.')
  if (input.report === 'fleet-maintenance' && !user.permissions.includes('expenses.read'))
    throw new AppError(403, 'FORBIDDEN', 'Your role cannot view maintenance expenses.')
  const report =
    input.report === 'customer-balances' || input.report === 'customer-payment-history'
      ? await queryCustomerPaymentReport({ ...input, report: input.report }, branchId)
      : input.report.startsWith('fleet-') || input.report === 'driver-allowances'
        ? await queryFleetReport(input, branchId)
        : await queryReport(input, branchId)
  if (forExport) {
    await recordReportExport({
      userId: user.id,
      branchId,
      reportType: input.report,
      title: report.title,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      rowCount: report.rows.length,
      filters: {
        vehicleId: input.vehicleId,
        driverId: input.driverId,
        customerId: input.customerId,
        branchId,
        status: input.status,
      },
      ipAddress: context?.ipAddress ?? null,
      requestId: context?.requestId ?? null,
    })
  }
  return report
}
