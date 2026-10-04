import { describe, expect, it } from 'vitest'
import {
  calculateOrderEligibility,
  type OrderLifecycleSnapshot,
} from '@/features/orders/order-lifecycle.domain.js'

function fulfilledOrder(overrides: Partial<OrderLifecycleSnapshot> = {}): OrderLifecycleSnapshot {
  return {
    id: 'order',
    orderNumber: 'QA-ORDER',
    branchId: 'branch',
    customerName: 'Synthetic customer',
    status: 'Delivered',
    stockMode: 'Reserved',
    totalAmount: '20.00',
    paidAmount: '20.00',
    processedRefundAmount: '0.00',
    pendingRefundAmount: '0.00',
    pendingReturnCount: 0,
    hasPayments: true,
    hasActiveDelivery: false,
    hasUnverifiedLegacyDelivery: false,
    items: [
      {
        id: 'line',
        productId: 'product',
        productName: 'Synthetic product',
        sku: 'QA',
        unit: 'piece',
        quantity: '2.000',
        cancelledQuantity: '0.000',
        unitPrice: '10.00',
        lineTotal: '20.00',
        deliveredQuantity: '2.000',
        returnedQuantity: '0.000',
        pendingDeliveryQuantity: '0.000',
        pendingReturnQuantity: '0.000',
        availableReservationQuantity: '0.000',
        reservationQuantity: '0.000',
      },
    ],
    ...overrides,
  }
}

describe('order lifecycle domain rules', () => {
  it.each([
    ['0.00', 'Unpaid', '20.00', false],
    ['5.00', 'Partially Paid', '15.00', false],
    ['20.00', 'Paid', '0.00', true],
    ['20.01', 'Overpaid', '-0.01', false],
  ] as const)(
    'requires exact cash settlement for a fulfilled order paid %s',
    (paidAmount, paymentStatus, balance, canComplete) => {
      const result = calculateOrderEligibility(fulfilledOrder({ paidAmount }))
      expect(result.financial).toMatchObject({ paymentStatus, balance, netPaid: paidAmount })
      expect(result.completion.canComplete).toBe(canComplete)
    },
  )

  it('keeps refunded money out of net paid and prevents completing an unsettled order', () => {
    const result = calculateOrderEligibility(fulfilledOrder({ processedRefundAmount: '20.00' }))
    expect(result.financial).toMatchObject({
      paymentStatus: 'Refunded',
      netPaid: '0.00',
      balance: '20.00',
    })
    expect(result.completion.canComplete).toBe(false)
  })

  it.each([
    [{ hasActiveDelivery: true }, 'DELIVERY_IN_PROGRESS'],
    [{ hasUnverifiedLegacyDelivery: true }, 'LEGACY_DELIVERY_RECONCILIATION_REQUIRED'],
    [{ pendingReturnCount: 1 }, 'RETURN_PENDING'],
    [{ pendingRefundAmount: '0.01' }, 'REFUND_PENDING'],
  ] as const)(
    'blocks changing an order while a related workflow is unresolved',
    (overrides, code) => {
      const result = calculateOrderEligibility(fulfilledOrder(overrides))
      expect(result.completion.canComplete).toBe(false)
      expect(result.completion.blockingReasons).toContainEqual(expect.objectContaining({ code }))
      expect(result.cancellation.blockingReasons).toContainEqual(expect.objectContaining({ code }))
    },
  )

  it('counts returned goods and remaining reservations when deciding completion', () => {
    const snapshot = fulfilledOrder()
    snapshot.items[0]!.returnedQuantity = '0.001'
    snapshot.items[0]!.reservationQuantity = '0.001'
    const result = calculateOrderEligibility(snapshot)
    expect(result.items[0]!.netDeliveredQuantity).toBe('1.999')
    expect(result.items[0]!.remainingToDeliver).toBe('0.001')
    expect(result.completion.blockingReasons.map((reason) => reason.code)).toEqual([
      'ORDER_NOT_FULLY_DELIVERED',
      'STOCK_RESERVATION_REMAINS',
    ])
  })
})
