import { z } from 'zod'
import { formatMoneyCents, moneyToCents } from '@/shared/domain/fixed-point.js'

const expenseAmountSchema = z
  .union([z.string().max(30), z.number().finite()])
  .transform((value, context) => {
    const text = String(value).trim()
    if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(text)) {
      context.addIssue({
        code: 'custom',
        message: 'Use an amount with at most two decimal places.',
      })
      return z.NEVER
    }
    const cents = moneyToCents(text)
    if (cents <= 0n || cents > 99_999_999_999_999n) {
      context.addIssue({
        code: 'custom',
        message: 'Use an amount from 0.01 to 999,999,999,999.99.',
      })
      return z.NEVER
    }
    return formatMoneyCents(cents)
  })

export const expenseCreateSchema = z
  .object({
    description: z.string().trim().min(2).max(240),
    category: z.string().trim().min(2).max(120),
    branchId: z.uuid().optional(),
    amount: expenseAmountSchema,
    requestKey: z
      .uuid()
      .transform((value) => value.toLowerCase())
      .optional(),
  })
  .strict()

export const expenseDetailQuerySchema = z
  .object({
    historyPage: z.coerce.number().int().min(1).max(100_000).default(1),
  })
  .strict()

export type ExpenseCreateInput = z.infer<typeof expenseCreateSchema>
export type ExpenseDetailQuery = z.infer<typeof expenseDetailQuerySchema>

export const expenseReviewSchema = z
  .object({
    decision: z.enum(['Approved', 'Rejected']),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === 'Rejected' && !value.note) {
      context.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'Add a reason when rejecting an expense.',
      })
    }
  })

export type ExpenseReviewInput = z.infer<typeof expenseReviewSchema>
