import { z } from 'zod'
import { quantityToMilli } from '@/features/orders/order.money.js'

export const deliveryStatuses = ['Scheduled', 'In Transit', 'Delivered', 'Failed'] as const

export const createDeliverySchema = z
  .object({
    orderId: z.uuid(),
    destination: z.string().trim().min(3).max(500),
    driverName: z.string().trim().max(180).optional(),
    driverId: z.uuid().optional(),
    vehicleId: z.uuid().optional(),
    startOdometer: z
      .string()
      .regex(/^\d{1,11}(?:\.\d{1,3})?$/)
      .optional(),
    scheduledAt: z.iso.datetime().optional(),
    items: z
      .array(
        z
          .object({
            orderItemId: z.uuid(),
            quantity: z
              .string()
              .regex(/^\d{1,10}(?:\.\d{1,3})?$/, 'Enter a quantity with up to three decimals.')
              .refine((quantity) => quantityToMilli(quantity) > 0n, 'Quantity must be positive.'),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .superRefine(({ items, driverId, vehicleId }, context) => {
    if (Boolean(driverId) !== Boolean(vehicleId))
      context.addIssue({
        code: 'custom',
        path: ['driverId'],
        message: 'Choose both a driver and vehicle, or leave both unassigned.',
      })
    const seen = new Set<string>()
    items.forEach((item, index) => {
      if (seen.has(item.orderItemId)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'orderItemId'],
          message: 'Each order line can only be included once.',
        })
      }
      seen.add(item.orderItemId)
    })
  })
  .strict()

export const updateDeliveryStatusSchema = z
  .object({
    status: z.enum(deliveryStatuses),
    endOdometer: z
      .string()
      .regex(/^\d{1,11}(?:\.\d{1,3})?$/)
      .optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict()
