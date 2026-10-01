import { describe, expect, it } from 'vitest'
import {
  createDeliverySchema,
  updateDeliveryStatusSchema,
} from '@/features/deliveries/delivery.schemas.js'
import { canTransitionDeliveryStatus } from '@/features/deliveries/delivery.transitions.js'

const orderId = '00000000-0000-4000-8000-000000000001'
const orderItemId = '00000000-0000-4000-8000-000000000002'

describe('delivery validation and status transitions', () => {
  it('accepts a scheduled delivery with a destination and driver', () => {
    const result = createDeliverySchema.safeParse({
      orderId,
      destination: '25 Sample Street, Manila',
      driverName: 'Alex Santos',
      scheduledAt: '2026-10-01T08:30:00.000Z',
      items: [{ orderItemId, quantity: '1.000' }],
    })

    expect(result.success).toBe(true)
  })

  it('rejects invalid destinations, datetimes, statuses, and extra fields', () => {
    expect(createDeliverySchema.safeParse({ orderId, destination: 'ab' }).success).toBe(false)
    expect(
      createDeliverySchema.safeParse({
        orderId,
        destination: '25 Sample Street, Manila',
        scheduledAt: 'tomorrow morning',
      }).success,
    ).toBe(false)
    expect(
      createDeliverySchema.safeParse({
        orderId,
        destination: '25 Sample Street, Manila',
        branchId: orderId,
      }).success,
    ).toBe(false)
    expect(updateDeliveryStatusSchema.safeParse({ status: 'Unknown' }).success).toBe(false)
    expect(
      createDeliverySchema.safeParse({
        orderId,
        destination: '25 Sample Street, Manila',
        items: [],
      }).success,
    ).toBe(false)
  })

  it('allows only forward delivery lifecycle transitions', () => {
    expect(canTransitionDeliveryStatus('Preparing', 'Scheduled')).toBe(true)
    expect(canTransitionDeliveryStatus('Scheduled', 'In Transit')).toBe(true)
    expect(canTransitionDeliveryStatus('In Transit', 'Delivered')).toBe(true)
    expect(canTransitionDeliveryStatus('In Transit', 'Preparing')).toBe(false)
    expect(canTransitionDeliveryStatus('Delivered', 'In Transit')).toBe(false)
  })
})
