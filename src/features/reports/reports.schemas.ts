import { z } from 'zod'

export const reportOptionsQuerySchema = z.object({ branchId: z.uuid().optional() }).strict()

export const reportQuerySchema = z
  .object({
    report: z.enum([
      'sales-by-branch',
      'approved-expenses',
      'inventory-health',
      'fleet-status',
      'fleet-assignments',
      'fleet-maintenance',
      'driver-allowances',
      'customer-balances',
      'customer-payment-history',
    ]),
    dateFrom: z.iso.date(),
    dateTo: z.iso.date(),
    branchId: z.uuid().optional(),
    vehicleId: z.uuid().optional(),
    driverId: z.uuid().optional(),
    customerId: z.uuid().optional(),
    status: z.string().trim().min(1).max(60).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const allowedFilters: Record<string, string[]> = {
      'fleet-status': ['vehicleId', 'driverId', 'status'],
      'fleet-assignments': ['vehicleId', 'driverId', 'customerId', 'status'],
      'fleet-maintenance': ['vehicleId', 'status'],
      'driver-allowances': ['vehicleId', 'driverId', 'customerId', 'status'],
      'customer-balances': ['customerId', 'status'],
      'customer-payment-history': ['customerId', 'status'],
    }
    for (const field of ['vehicleId', 'driverId', 'customerId', 'status'] as const)
      if (value[field] && !allowedFilters[value.report]?.includes(field))
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'This filter does not apply to the selected report.',
        })
    const statuses: Record<string, string[]> = {
      'fleet-status': ['Available', 'On Service', 'Under Maintenance', 'Unavailable'],
      'fleet-assignments': ['Scheduled', 'Active', 'Completed', 'Cancelled'],
      'fleet-maintenance': ['Scheduled', 'In Progress', 'Completed', 'Cancelled'],
      'driver-allowances': ['Pending', 'Approved', 'Released', 'Received', 'Cancelled'],
      'customer-balances': ['Unpaid', 'Partially Paid', 'Paid', 'Cancelled', 'Overpaid'],
      'customer-payment-history': ['Unpaid', 'Partially Paid', 'Paid', 'Cancelled', 'Overpaid'],
    }
    if (value.status && !statuses[value.report]?.includes(value.status))
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Choose a status for the selected report.',
      })
    const from = Date.parse(`${value.dateFrom}T00:00:00Z`)
    const to = Date.parse(`${value.dateTo}T00:00:00Z`)
    const days = (to - from) / 86_400_000

    if (days < 0) {
      context.addIssue({
        code: 'custom',
        path: ['dateTo'],
        message: 'The end date must be on or after the start date.',
      })
    } else if (days > 366) {
      context.addIssue({
        code: 'custom',
        path: ['dateTo'],
        message: 'Report date ranges cannot exceed 367 days.',
      })
    }
  })

export type ReportQuery = z.infer<typeof reportQuerySchema>
export type ReportType = ReportQuery['report']
