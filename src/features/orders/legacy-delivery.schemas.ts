import { z } from 'zod'
import { quantityToMilli } from './order.money.js'

export const reconcileLegacyDeliverySchema = z
  .object({
    note: z.string().trim().min(10).max(1000),
    items: z
      .array(
        z
          .object({
            orderItemId: z.uuid(),
            quantity: z
              .string()
              .regex(
                /^\d{1,11}(?:\.\d{1,3})?$/,
                'Enter a non-negative quantity with up to three decimals.',
              )
              .refine((value) => quantityToMilli(value) >= 0n),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .superRefine(({ items }, context) => {
    const seen = new Set<string>()
    items.forEach((item, index) => {
      if (seen.has(item.orderItemId)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'orderItemId'],
          message: 'Include each order line once.',
        })
      }
      seen.add(item.orderItemId)
    })
  })
  .strict()

export type ReconcileLegacyDeliveryInput = z.infer<typeof reconcileLegacyDeliverySchema>
