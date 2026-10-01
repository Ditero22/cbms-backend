import { describe, expect, it } from 'vitest'
import { recordPaymentSchema } from '@/features/payments/payment.schemas.js'
import { philippineDate } from '@/shared/philippine-date.js'

const orderId = '00000000-0000-4000-8000-000000000001'

describe('payment validation', () => {
  it('normalizes a valid amount to two decimal places', () => {
    const result = recordPaymentSchema.safeParse({
      orderId,
      amount: '125.5',
      method: 'Cash',
    })

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.amount).toBe('125.50')
  })

  it('rejects zero, excess decimal places, unsupported methods, and unknown fields', () => {
    const base = { orderId, method: 'Cash' }
    expect(recordPaymentSchema.safeParse({ ...base, amount: '0' }).success).toBe(false)
    expect(recordPaymentSchema.safeParse({ ...base, amount: '1.001' }).success).toBe(false)
    expect(recordPaymentSchema.safeParse({ ...base, amount: '1000000000000.00' }).success).toBe(
      false,
    )
    expect(
      recordPaymentSchema.safeParse({ orderId, amount: '1.00', method: 'Cryptocurrency' }).success,
    ).toBe(false)
    expect(
      recordPaymentSchema.safeParse({ ...base, amount: '1.00', customerId: orderId }).success,
    ).toBe(false)
  })

  it('accepts dated GCash receipts with independent reference, notes, and retry key', () => {
    const result = recordPaymentSchema.parse({
      orderId,
      amount: '30',
      method: 'GCash',
      paymentDate: philippineDate(),
      requestKey: orderId,
      externalReference: '  GCash-01234  ',
      notes: '  First payment  ',
    })
    expect(result).toMatchObject({
      amount: '30.00',
      externalReference: 'GCash-01234',
      notes: 'First payment',
      method: 'GCash',
    })
    expect(
      recordPaymentSchema.safeParse({ orderId, amount: '1.00', method: 'Other' }).success,
    ).toBe(true)
  })

  it('rejects invalid dates, future receipts, invalid retry keys and excessive metadata', () => {
    const base = { orderId, amount: '1.00', method: 'Cash' }
    expect(recordPaymentSchema.safeParse({ ...base, paymentDate: '2026-02-30' }).success).toBe(
      false,
    )
    expect(recordPaymentSchema.safeParse({ ...base, paymentDate: '9999-12-31' }).success).toBe(
      false,
    )
    expect(recordPaymentSchema.safeParse({ ...base, requestKey: 'unsafe-key' }).success).toBe(false)
    expect(
      recordPaymentSchema.safeParse({ ...base, externalReference: 'x'.repeat(201) }).success,
    ).toBe(false)
    expect(recordPaymentSchema.safeParse({ ...base, notes: 'x'.repeat(2001) }).success).toBe(false)
  })
})
