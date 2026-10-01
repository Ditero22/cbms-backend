import { z } from 'zod'
import { formatMoneyCents, moneyToCents } from '@/features/orders/order.money.js'
import { paymentMethods } from './payment.schemas.js'

const amountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}(?:\.\d{1,2})?$/, 'Enter a positive amount with up to two decimal places.')
  .transform((value) => formatMoneyCents(moneyToCents(value)))
  .refine((value) => moneyToCents(value) > 0n, 'Refund amount must be greater than zero.')

export const refundMethods = paymentMethods

export const requestRefundSchema = z
  .object({
    requestKey: z.uuid(),
    paymentId: z.uuid(),
    amount: amountSchema,
    method: z.enum(refundMethods),
    reason: z.string().trim().min(3).max(300),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict()

export const rejectWorkflowSchema = z
  .object({ reason: z.string().trim().min(3).max(1000) })
  .strict()

export const processRefundSchema = z
  .object({ reference: z.string().trim().min(2).max(180).optional() })
  .strict()
