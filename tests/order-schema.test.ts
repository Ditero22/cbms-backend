import { describe, expect, it } from 'vitest'
import { orderSchema } from '@/features/records/record-schemas.js'
import {
  calculateLineTotal,
  calculateOrderTotal,
  isOrderAmountRepresentable,
} from '@/features/orders/order.money.js'

const customerId = '00000000-0000-4000-8000-000000000001'
const branchId = '00000000-0000-4000-8000-000000000002'
const firstProductId = '00000000-0000-4000-8000-000000000003'
const secondProductId = '00000000-0000-4000-8000-000000000004'

describe('order validation and totals', () => {
  it('accepts a multi-item order with quantities at inventory precision', () => {
    const result = orderSchema.safeParse({
      customerId,
      branchId,
      items: [
        { productId: firstProductId, quantity: '2.375' },
        { productId: secondProductId, quantity: 1 },
      ],
    })

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.items[0]?.quantity).toBe(2.375)
  })

  it('rejects empty orders, duplicate products, and quantities beyond inventory precision', () => {
    expect(orderSchema.safeParse({ customerId, branchId, items: [] }).success).toBe(false)
    expect(
      orderSchema.safeParse({
        customerId,
        branchId,
        items: [
          { productId: firstProductId, quantity: 1 },
          { productId: firstProductId, quantity: 2 },
        ],
      }).success,
    ).toBe(false)
    expect(
      orderSchema.safeParse({
        customerId,
        branchId,
        items: [{ productId: firstProductId, quantity: 1.0001 }],
      }).success,
    ).toBe(false)
  })

  it('calculates fractional line amounts and order totals in cents', () => {
    const fractionalLine = calculateLineTotal('1.05', 0.333)
    const secondLine = calculateLineTotal('9.99', 1)

    expect(fractionalLine).toBe('0.35')
    expect(calculateOrderTotal([fractionalLine, secondLine])).toBe('10.34')
    expect(calculateLineTotal('99999999999.99', 1)).toBe('99999999999.99')
    expect(isOrderAmountRepresentable(['999999999999.99'])).toBe(true)
    expect(isOrderAmountRepresentable(['1000000000000.00'])).toBe(false)
  })
})
