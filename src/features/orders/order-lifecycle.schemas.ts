import { z } from 'zod'
import { quantityToMilli } from '@/shared/domain/fixed-point.js'

export const cancellationReasons = [
  'customer request',
  'duplicate order',
  'incorrect order',
  'project cancelled',
  'unavailable materials',
  'pricing error',
  'payment issue',
  'management decision',
  'other',
] as const

const cancellationItem = z
  .object({
    orderItemId: z.uuid(),
    quantity: z
      .string()
      .regex(/^\d{1,10}(?:\.\d{1,3})?$/, 'Enter a quantity with up to three decimals.')
      .refine((quantity) => quantityToMilli(quantity) > 0n, 'Quantity must be positive.'),
  })
  .strict()

export const cancelOrderSchema = z
  .object({
    reason: z.enum(cancellationReasons),
    notes: z.string().trim().max(1000).optional(),
    items: z.array(cancellationItem).min(1).max(100).optional(),
  })
  .superRefine((input, context) => {
    if (input.reason === 'other' && !input.notes?.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['notes'],
        message: 'Add a note when the reason is Other.',
      })
    }
    const seen = new Set<string>()
    input.items?.forEach((item, index) => {
      if (seen.has(item.orderItemId)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'orderItemId'],
          message: 'Each order line can only be cancelled once per request.',
        })
      }
      seen.add(item.orderItemId)
    })
  })
  .strict()
