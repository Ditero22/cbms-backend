import { z } from 'zod'
import { formatMoneyCents, moneyToCents } from '@/features/orders/order.money.js'

const money = z
  .string()
  .trim()
  .regex(
    /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/,
    'Enter a non-negative amount with up to two decimals.',
  )
  .transform((value) => formatMoneyCents(moneyToCents(value)))

const units = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/, 'Enter a quantity with up to three decimals.')
  .refine((value) => Number(value) > 0, 'Quantity must be greater than zero.')

const earningAdjustmentSchema = z.object({
  kind: z.literal('earning'),
  type: z.enum(['Overtime', 'Bonus', 'Allowance', 'Reimbursement', 'Other compensation']),
  amount: money.refine((value) => moneyToCents(value) > 0n, 'Amount must be greater than zero.'),
  notes: z.string().trim().max(300).optional().default(''),
})

const deductionAdjustmentSchema = z.object({
  kind: z.literal('deduction'),
  type: z.enum(['Deduction', 'Cash advance recovery']),
  amount: money.refine((value) => moneyToCents(value) > 0n, 'Amount must be greater than zero.'),
  notes: z.string().trim().max(300).optional().default(''),
})

const adjustmentSchema = z.discriminatedUnion('kind', [
  earningAdjustmentSchema,
  deductionAdjustmentSchema,
])

const entrySchema = z.object({
  employeeId: z.uuid(),
  payBasis: z.enum(['Salary', 'Daily wage', 'Weekly wage', 'Per-trip pay', 'Other']),
  units,
  rate: money.refine((value) => moneyToCents(value) > 0n, 'Rate must be greater than zero.'),
  adjustments: z.array(adjustmentSchema).max(30),
})

const runFields = {
  branchId: z.uuid(),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  entries: z.array(entrySchema).min(1, 'Add at least one employee to the pay run.').max(500),
}

function validateRun(value: z.infer<z.ZodObject<typeof runFields>>, context: z.RefinementCtx) {
  if (value.periodStart > value.periodEnd) {
    context.addIssue({
      code: 'custom',
      path: ['periodEnd'],
      message: 'The period end must be on or after the period start.',
    })
  }
  const ids = new Set<string>()
  value.entries.forEach((entry, index) => {
    if (ids.has(entry.employeeId)) {
      context.addIssue({
        code: 'custom',
        path: ['entries', index, 'employeeId'],
        message: 'An employee can only appear once in a pay run.',
      })
    }
    ids.add(entry.employeeId)
  })
}

export const createPayrollRunSchema = z
  .object({ ...runFields, requestKey: z.uuid().optional() })
  .strict()
  .superRefine(validateRun)

export const updatePayrollRunSchema = z.object(runFields).strict().superRefine(validateRun)

export const markPayrollPaidSchema = z
  .object({
    paymentDate: z.iso.date(),
    paymentMethod: z.enum(['Cash', 'GCash', 'Bank transfer', 'Check', 'Other']),
    paymentReference: z.string().trim().max(100).optional().default(''),
    paymentNotes: z.string().trim().max(2000).optional().default(''),
    requestKey: z.uuid().optional(),
  })
  .strict()

export const confirmPayrollReceiptSchema = z
  .object({
    receivedAt: z.iso.datetime({ offset: true }),
    acknowledgement: z.string().trim().max(500).optional().default(''),
    proofAttachmentId: z.uuid().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.acknowledgement || value.proofAttachmentId), {
    path: ['acknowledgement'],
    message: 'Add an acknowledgement or attach proof that the employee received payment.',
  })

export const payrollDetailQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict()

export const payrollOptionsQuerySchema = z.object({ branchId: z.uuid().optional() }).strict()

export const payrollLedgerQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(25),
    search: z.string().trim().max(200).default(''),
    branchId: z.uuid().optional(),
    paymentStatus: z.enum(['', 'Pending', 'Paid', 'Received']).default(''),
    periodStart: z.iso.date().optional(),
    periodEnd: z.iso.date().optional(),
    sort: z.enum(['employee', 'period', 'netPay', 'paymentStatus']).default('period'),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict()
  .refine(
    (query) => !query.periodStart || !query.periodEnd || query.periodStart <= query.periodEnd,
    { path: ['periodEnd'], message: 'Choose an ordered payroll period.' },
  )
export type PayrollLedgerQuery = z.infer<typeof payrollLedgerQuerySchema>

export type CreatePayrollRunInput = z.infer<typeof createPayrollRunSchema>
export type UpdatePayrollRunInput = z.infer<typeof updatePayrollRunSchema>
export type MarkPayrollPaidInput = z.infer<typeof markPayrollPaidSchema>
export type ConfirmPayrollReceiptInput = z.infer<typeof confirmPayrollReceiptSchema>
