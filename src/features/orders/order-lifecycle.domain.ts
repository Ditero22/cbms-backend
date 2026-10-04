import {
  formatMoneyCents,
  formatQuantityMilli,
  moneyToCents,
  quantityToMilli,
} from '@/shared/domain/fixed-point.js'
import { calculateLineTotalMilli } from './order.money.js'

export type OrderLifecycleSnapshot = {
  id: string
  orderNumber: string
  branchId: string
  customerName: string
  status: string
  stockMode: 'Reserved' | 'LegacyConsumed'
  totalAmount: string
  items: OrderLifecycleItem[]
  paidAmount: string
  processedRefundAmount: string
  pendingRefundAmount: string
  pendingReturnCount: number
  hasPayments: boolean
  hasActiveDelivery: boolean
  hasUnverifiedLegacyDelivery: boolean
}

export type OrderLifecycleItem = {
  id: string
  productId: string
  productName: string
  sku: string
  unit: string
  quantity: string
  cancelledQuantity: string
  unitPrice: string
  lineTotal: string
  deliveredQuantity: string
  returnedQuantity: string
  pendingDeliveryQuantity: string
  pendingReturnQuantity: string
  availableReservationQuantity: string
  reservationQuantity: string
}

export function calculateOrderEligibility(snapshot: OrderLifecycleSnapshot) {
  const blockingReasons: { code: string; message: string }[] = []
  const completionReasons: { code: string; message: string }[] = []
  if (snapshot.hasUnverifiedLegacyDelivery) {
    const reason = {
      code: 'LEGACY_DELIVERY_RECONCILIATION_REQUIRED',
      message: 'Verify the historical delivery quantities before changing this order.',
    }
    blockingReasons.push(reason)
    completionReasons.push(reason)
  }
  const itemSummary = snapshot.items.map((item) => {
    const ordered = quantityToMilli(item.quantity)
    const delivered = quantityToMilli(item.deliveredQuantity)
    const returned = quantityToMilli(item.returnedQuantity)
    const cancelled = quantityToMilli(item.cancelledQuantity)
    const netDelivered = delivered - returned
    const cancellable = ordered - netDelivered - cancelled
    const completionQuantity = netDelivered + cancelled
    return {
      ...item,
      netDeliveredQuantity: formatQuantityMilli(netDelivered),
      cancellableQuantity: formatQuantityMilli(cancellable > 0n ? cancellable : 0n),
      remainingToDeliver: formatQuantityMilli(cancellable > 0n ? cancellable : 0n),
      fulfillmentComplete: completionQuantity >= ordered,
    }
  })
  const hasOutstandingDelivery = itemSummary.some((item) => !item.fulfillmentComplete)
  if (snapshot.status === 'Cancelled') {
    blockingReasons.push({
      code: 'ORDER_ALREADY_CANCELLED',
      message: 'This order has already been cancelled.',
    })
    completionReasons.push({
      code: 'ORDER_ALREADY_CANCELLED',
      message: 'Cancelled orders cannot be completed.',
    })
  }
  if (snapshot.status === 'Completed') {
    blockingReasons.push({
      code: 'ORDER_ALREADY_COMPLETED',
      message: 'Completed orders cannot be cancelled directly.',
    })
    completionReasons.push({
      code: 'ORDER_ALREADY_COMPLETED',
      message: 'This order has already been completed.',
    })
  }
  if (snapshot.hasActiveDelivery) {
    const reason = {
      code: 'DELIVERY_IN_PROGRESS',
      message: 'Finish or fail the active delivery before changing order quantities.',
    }
    blockingReasons.push(reason)
    completionReasons.push(reason)
  }
  if (snapshot.pendingReturnCount > 0) {
    const reason = {
      code: 'RETURN_PENDING',
      message: 'Approve, reject, or receive pending returns before changing this order.',
    }
    blockingReasons.push(reason)
    completionReasons.push(reason)
  }
  if (quantityToMilli(snapshot.pendingRefundAmount) > 0n) {
    const reason = {
      code: 'REFUND_PENDING',
      message: 'Resolve requested or approved refunds before changing this order.',
    }
    blockingReasons.push(reason)
    completionReasons.push(reason)
  }

  const payableCents = snapshot.items.reduce((total, item) => {
    const canceledValue = moneyToCents(
      calculateLineTotalMilli(item.unitPrice, quantityToMilli(item.cancelledQuantity)),
    )
    return total + moneyToCents(item.lineTotal) - canceledValue
  }, 0n)
  const paidCents = moneyToCents(snapshot.paidAmount)
  const refundedCents = moneyToCents(snapshot.processedRefundAmount)
  const netPaidCents = paidCents - refundedCents
  const balanceCents = payableCents - netPaidCents
  const netPaid = formatMoneyCents(netPaidCents)
  const payableAmount = formatMoneyCents(payableCents)
  const balance = formatMoneyCents(balanceCents)
  const paymentStatus =
    paidCents > 0n && netPaidCents === 0n
      ? 'Refunded'
      : netPaidCents === 0n
        ? 'Unpaid'
        : netPaidCents < payableCents
          ? 'Partially Paid'
          : netPaidCents === payableCents
            ? 'Paid'
            : 'Overpaid'

  if (itemSummary.some((item) => quantityToMilli(item.netDeliveredQuantity) > 0n)) {
    blockingReasons.push({
      code: 'ORDER_HAS_DELIVERED_ITEMS',
      message: 'Delivered quantities must be returned before the whole order can be cancelled.',
    })
  }
  if (hasOutstandingDelivery) {
    completionReasons.push({
      code: 'ORDER_NOT_FULLY_DELIVERED',
      message: 'Deliver or cancel all remaining quantities before completing this order.',
    })
  }
  if (snapshot.items.length === 0) {
    completionReasons.push({
      code: 'ORDER_HAS_NO_ITEMS',
      message: 'An order without items cannot be completed.',
    })
  }
  if (balanceCents > 0n) {
    completionReasons.push({
      code: 'ORDER_BALANCE_REMAINS',
      message: `Record payment for the remaining ₱${balance} before completing this cash order. Credit terms are not configured.`,
    })
  } else if (balanceCents < 0n) {
    completionReasons.push({
      code: 'ORDER_OVERPAID',
      message: `This order has an overpayment of ₱${formatMoneyCents(-balanceCents)}. Refund it before completion.`,
    })
  }
  if (
    snapshot.stockMode === 'Reserved' &&
    snapshot.items.some((item) => quantityToMilli(item.reservationQuantity) > 0n)
  ) {
    completionReasons.push({
      code: 'STOCK_RESERVATION_REMAINS',
      message: 'Release or fulfill all remaining stock reservations before completing this order.',
    })
  }

  return {
    id: snapshot.id,
    orderNumber: snapshot.orderNumber,
    status: snapshot.status,
    customerName: snapshot.customerName,
    stockMode: snapshot.stockMode,
    requiresLegacyDeliveryReconciliation: snapshot.hasUnverifiedLegacyDelivery,
    financial: {
      orderTotal: payableAmount,
      originalOrderTotal: snapshot.totalAmount,
      paidAmount: snapshot.paidAmount,
      refundedAmount: snapshot.processedRefundAmount,
      pendingRefundAmount: snapshot.pendingRefundAmount,
      netPaid,
      balance,
      paymentStatus,
      hasRecordedPayment: snapshot.hasPayments,
    },
    items: itemSummary,
    cancellation: {
      canCancel: blockingReasons.length === 0,
      canCancelRemaining:
        !['Cancelled', 'Completed'].includes(snapshot.status) &&
        !snapshot.hasUnverifiedLegacyDelivery &&
        itemSummary.some((item) => quantityToMilli(item.cancellableQuantity) > 0n) &&
        !snapshot.hasActiveDelivery &&
        snapshot.pendingReturnCount === 0 &&
        quantityToMilli(snapshot.pendingRefundAmount) === 0n,
      requiresRefund: snapshot.hasPayments && netPaidCents > 0n,
      requiresReturn: itemSummary.some((item) => quantityToMilli(item.netDeliveredQuantity) > 0n),
      reservedQuantityToRelease: formatQuantityMilli(
        snapshot.items.reduce(
          (total, item) => total + quantityToMilli(item.reservationQuantity),
          0n,
        ),
      ),
      deliveredQuantity: formatQuantityMilli(
        snapshot.items.reduce((total, item) => total + quantityToMilli(item.deliveredQuantity), 0n),
      ),
      blockingReasons,
    },
    completion: {
      canComplete: completionReasons.length === 0,
      deliveryComplete: !hasOutstandingDelivery && snapshot.items.length > 0,
      paymentRequirementSatisfied: balanceCents === 0n,
      outstandingBalance: balance,
      hasPendingReturn: snapshot.pendingReturnCount > 0,
      hasPendingCancellation: false,
      blockingReasons: completionReasons,
    },
  }
}
