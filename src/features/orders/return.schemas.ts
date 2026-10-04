import { z } from 'zod'
import { quantityToMilli } from '@/shared/domain/fixed-point.js'

const quantitySchema = z
  .string()
  .regex(/^\d{1,10}(?:\.\d{1,3})?$/, 'Enter a quantity with up to three decimals.')
  .refine((value) => quantityToMilli(value) > 0n, 'Quantity must be positive.')

export const returnConditions = [
  'Resalable',
  'Damaged',
  'Defective',
  'Used',
  'Lost',
  'Non-returnable',
] as const
const remainderConditions = ['Damaged', 'Defective', 'Used', 'Lost', 'Non-returnable'] as const

export const requestReturnSchema = z
  .object({
    requestKey: z.uuid(),
    deliveryId: z.uuid(),
    reason: z.string().trim().min(3).max(300),
    notes: z.string().trim().max(1000).optional(),
    items: z
      .array(z.object({ orderItemId: z.uuid(), quantity: quantitySchema }).strict())
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
          message: 'Each order line can only be returned once.',
        })
      }
      seen.add(item.orderItemId)
    })
  })
  .strict()

export const receiveReturnSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            orderItemId: z.uuid(),
            condition: z.enum(returnConditions),
            remainderCondition: z.enum(remainderConditions).optional(),
            acceptedQuantity: z
              .string()
              .regex(/^\d{1,10}(?:\.\d{1,3})?$/)
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
          message: 'Each returned order line can only be classified once.',
        })
      }
      if (item.condition !== 'Resalable' && quantityToMilli(item.acceptedQuantity) !== 0n) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'acceptedQuantity'],
          message: 'Only resalable items can be accepted back into inventory.',
        })
      }
      if (item.condition !== 'Resalable' && item.remainderCondition !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'remainderCondition'],
          message: 'A remainder condition is only needed for a partly resalable return.',
        })
      }
      seen.add(item.orderItemId)
    })
  })
  .strict()

export type ReceiveReturnInput = z.infer<typeof receiveReturnSchema>
