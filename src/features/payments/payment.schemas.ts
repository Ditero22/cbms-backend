import { z } from 'zod'
import { formatMoneyCents, moneyToCents } from '@/shared/domain/fixed-point.js'
import { philippineDate } from '@/shared/philippine-date.js'

export const paymentMethods = ['Cash', 'GCash', 'Bank transfer', 'Card', 'Cheque', 'Other'] as const

const amountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}(?:\.\d{1,2})?$/, 'Enter a positive amount with up to two decimal places.')
  .transform((amount) => formatMoneyCents(moneyToCents(amount)))
  .refine((amount) => moneyToCents(amount) > 0n, 'Payment amount must be greater than zero.')

export const recordPaymentSchema = z
  .object({
    orderId: z.uuid(),
    amount: amountSchema,
    method: z.enum(paymentMethods),
    requestKey: z.uuid().optional(),
    paymentDate: z.iso
      .date()
      .refine((value) => value <= philippineDate(), 'Payment date cannot be in the future.')
      .optional(),
    externalReference: z.string().trim().max(200).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict()

export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>
