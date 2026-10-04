import { calculateOrderEligibility } from './order-lifecycle.domain.js'
import type { PoolClient } from 'pg'
import { withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import { calculateLineTotalMilli } from './order.money.js'
import {
  formatMoneyCents,
  formatQuantityMilli,
  moneyToCents,
  quantityToMilli,
} from '@/shared/domain/fixed-point.js'
import * as lifecycleRepository from './order-lifecycle.repository.js'

type LifecycleContext = {
  user: AuthenticatedUser
  ipAddress: string | null
  requestId: string | null
}

export type CancelOrderInput = {
  reason: string
  notes?: string | undefined
  items?: { orderItemId: string; quantity: string }[] | undefined
}

export async function getOrderLifecycleEligibility(orderId: string, user: AuthenticatedUser) {
  requirePermission(user, 'sales.read', 'You do not have permission to view orders.')
  const branchScope = getAssignedBranchScope(user)
  return withTransaction(async (client) => {
    await client.query('set transaction isolation level repeatable read read only')
    const snapshot = await lifecycleRepository.getOrderLifecycleSnapshot(client, orderId)
    if (!snapshot || (branchScope && snapshot.branchId !== branchScope)) {
      throw new AppError(404, 'ORDER_NOT_FOUND', 'The requested order was not found.')
    }
    return calculateOrderEligibility(snapshot)
  })
}

export async function completeOrder(orderId: string, context: LifecycleContext) {
  requirePermission(
    context.user,
    'orders.complete',
    'You do not have permission to complete orders.',
  )
  return withTransaction(async (client) => {
    const snapshot = await loadSnapshot(client, orderId, context.user)
    const eligibility = calculateOrderEligibility(snapshot)
    if (!eligibility.completion.canComplete) {
      const first = eligibility.completion.blockingReasons[0]
      throw new AppError(
        409,
        first?.code ?? 'ORDER_NOT_READY_FOR_COMPLETION',
        first?.message ?? 'This order is not ready to be completed.',
        eligibility.completion,
      )
    }

    await lifecycleRepository.updateOrderStatus(client, {
      orderId: snapshot.id,
      status: 'Completed',
      completedBy: context.user.id,
    })
    await lifecycleRepository.insertOrderLifecycleAudit(client, {
      userId: context.user.id,
      branchId: snapshot.branchId,
      orderId: snapshot.id,
      action: 'completed order',
      data: {
        orderNumber: snapshot.orderNumber,
        previousStatus: snapshot.status,
        status: 'Completed',
        totalAmount: eligibility.financial.orderTotal,
        paidAmount: eligibility.financial.netPaid,
        balance: eligibility.financial.balance,
      },
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })
    return { id: snapshot.id, orderNumber: snapshot.orderNumber, status: 'Completed' }
  })
}

export async function cancelOrder(
  orderId: string,
  input: CancelOrderInput,
  context: LifecycleContext,
) {
  requirePermission(context.user, 'orders.cancel', 'You do not have permission to cancel orders.')
  return withTransaction(async (client) => {
    const snapshot = await loadSnapshot(client, orderId, context.user)
    const eligibility = calculateOrderEligibility(snapshot)
    const actionBlockers = eligibility.cancellation.blockingReasons.filter(
      (reason) => reason.code !== 'ORDER_HAS_DELIVERED_ITEMS',
    )
    if (actionBlockers.length > 0) {
      const first = actionBlockers[0]
      throw new AppError(
        409,
        first?.code ?? 'ORDER_NOT_CANCELLABLE',
        first?.message ?? 'This order cannot be cancelled.',
        {
          blockingReasons: actionBlockers,
        },
      )
    }

    if (
      !input.items &&
      eligibility.items.some((item) => quantityToMilli(item.netDeliveredQuantity) > 0n)
    ) {
      throw new AppError(
        409,
        'RETURN_REQUIRED_BEFORE_CANCELLATION',
        'Some items have been delivered. Complete returns for those delivered quantities before cancelling the whole order.',
        {
          items: eligibility.items.filter(
            (item) => quantityToMilli(item.netDeliveredQuantity) > 0n,
          ),
        },
      )
    }

    const requestedItems = input.items?.length
      ? input.items
      : eligibility.items
          .map((item) => ({ orderItemId: item.id, quantity: item.cancellableQuantity }))
          .filter((item) => quantityToMilli(item.quantity) > 0n)
    if (!requestedItems.length) {
      throw new AppError(409, 'NOTHING_TO_CANCEL', 'There are no remaining quantities to cancel.')
    }

    const itemMap = new Map(snapshot.items.map((item) => [item.id, item]))
    const cancelled = [] as { orderItemId: string; productName: string; quantity: string }[]
    const sortedRequests = [...requestedItems].sort((left, right) => {
      const leftProduct = itemMap.get(left.orderItemId)?.productId ?? ''
      const rightProduct = itemMap.get(right.orderItemId)?.productId ?? ''
      return (
        leftProduct.localeCompare(rightProduct) || left.orderItemId.localeCompare(right.orderItemId)
      )
    })
    const seenItems = new Set<string>()
    const plans = sortedRequests.map((request) => {
      if (seenItems.has(request.orderItemId)) {
        throw new AppError(
          400,
          'DUPLICATE_CANCELLATION_ITEM',
          'Each order line can only be cancelled once per request.',
        )
      }
      seenItems.add(request.orderItemId)
      const item = itemMap.get(request.orderItemId)
      if (!item) throw new AppError(404, 'ORDER_ITEM_NOT_FOUND', 'Choose an item on this order.')
      const ordered = quantityToMilli(item.quantity)
      const delivered = quantityToMilli(item.deliveredQuantity)
      const returned = quantityToMilli(item.returnedQuantity)
      const alreadyCancelled = quantityToMilli(item.cancelledQuantity)
      const maxCancellable = ordered - delivered + returned - alreadyCancelled
      const requested = quantityToMilli(request.quantity)
      if (requested <= 0n || requested > maxCancellable) {
        throw new AppError(
          409,
          'CANCEL_EXCEEDS_REMAINING',
          `${item.productName} has only ${formatQuantityMilli(maxCancellable)} ${item.unit} available to cancel.`,
          { orderItemId: item.id, maxCancellable: formatQuantityMilli(maxCancellable) },
        )
      }
      return { request, item, ordered, delivered, alreadyCancelled, requested }
    })

    const payableBeforeCancellation = snapshot.items.reduce((total, item) => {
      const cancelledValue = moneyToCents(
        calculateLineTotalMilli(item.unitPrice, quantityToMilli(item.cancelledQuantity)),
      )
      return total + moneyToCents(item.lineTotal) - cancelledValue
    }, 0n)
    const cancellationValue = plans.reduce(
      (total, plan) =>
        total +
        moneyToCents(
          calculateLineTotalMilli(plan.item.unitPrice, plan.alreadyCancelled + plan.requested),
        ) -
        moneyToCents(calculateLineTotalMilli(plan.item.unitPrice, plan.alreadyCancelled)),
      0n,
    )
    const payableAfterCancellation = payableBeforeCancellation - cancellationValue
    const netPaidCents =
      moneyToCents(snapshot.paidAmount) - moneyToCents(snapshot.processedRefundAmount)
    if (netPaidCents > payableAfterCancellation) {
      const refundRequired = netPaidCents - payableAfterCancellation
      throw new AppError(
        409,
        'PAYMENT_REFUND_REQUIRED',
        `Process a refund of at least ₱${formatMoneyCents(refundRequired)} for the cancelled quantities before continuing.`,
        {
          requiredRefundAmount: formatMoneyCents(refundRequired),
          netPaidAmount: formatMoneyCents(netPaidCents),
          payableAfterCancellation: formatMoneyCents(payableAfterCancellation),
        },
      )
    }

    for (const { item, ordered, delivered, alreadyCancelled, requested } of plans) {
      if (snapshot.stockMode === 'Reserved') {
        let toRelease = requested
        const reservations = await lifecycleRepository.getReservationRowsForUpdate(client, item.id)
        for (const reservation of reservations) {
          const available =
            quantityToMilli(reservation.quantity) -
            quantityToMilli(reservation.fulfilledQuantity) -
            quantityToMilli(reservation.releasedQuantity) -
            quantityToMilli(reservation.pendingQuantity)
          if (available <= 0n || toRelease <= 0n) continue
          const release = available < toRelease ? available : toRelease
          const updated = await lifecycleRepository.markReservationReleased(
            client,
            reservation.id,
            formatQuantityMilli(release),
          )
          const stock = updated
            ? await lifecycleRepository.adjustInventoryReservation(client, {
                productId: item.productId,
                branchId: snapshot.branchId,
                quantityDelta: formatQuantityMilli(-release),
              })
            : undefined
          if (!updated || !stock) {
            throw new AppError(
              409,
              'RESERVATION_RELEASE_FAILED',
              'The stock reservation could not be safely released.',
            )
          }
          await lifecycleRepository.insertLifecycleInventoryMovement(client, {
            productId: item.productId,
            branchId: snapshot.branchId,
            transactionType: 'RESERVATION_RELEASED',
            quantityDelta: formatQuantityMilli(-release),
            orderId: snapshot.id,
            note: `Reservation released: ${input.reason}`,
            performedBy: context.user.id,
          })
          toRelease -= release
        }
      } else {
        const unfulfilledBeforeCancel = ordered - delivered - alreadyCancelled
        const restore = requested < unfulfilledBeforeCancel ? requested : unfulfilledBeforeCancel
        if (restore > 0n) {
          const stock = await lifecycleRepository.restockInventory(client, {
            productId: item.productId,
            branchId: snapshot.branchId,
            quantity: formatQuantityMilli(restore),
          })
          if (!stock) throw new Error('Legacy consumed stock could not be restored.')
          await lifecycleRepository.insertLifecycleInventoryMovement(client, {
            productId: item.productId,
            branchId: snapshot.branchId,
            transactionType: 'ORDER_CANCELLATION_RESTOCK',
            quantityDelta: formatQuantityMilli(restore),
            orderId: snapshot.id,
            note: `Unfulfilled legacy order quantity restored: ${input.reason}`,
            performedBy: context.user.id,
          })
        }
      }

      await lifecycleRepository.setItemCancelledQuantity(
        client,
        item.id,
        formatQuantityMilli(requested),
      )
      cancelled.push({
        orderItemId: item.id,
        productName: item.productName,
        quantity: formatQuantityMilli(requested),
      })
    }

    const updatedSnapshot = await lifecycleRepository.getOrderLifecycleSnapshot(client, snapshot.id)
    if (!updatedSnapshot) throw new Error('The order disappeared during cancellation.')
    const allFulfilled = updatedSnapshot.items.every(
      (item) =>
        quantityToMilli(item.deliveredQuantity) -
          quantityToMilli(item.returnedQuantity) +
          quantityToMilli(item.cancelledQuantity) >=
        quantityToMilli(item.quantity),
    )
    const noOutstandingDelivered = updatedSnapshot.items.every(
      (item) => quantityToMilli(item.deliveredQuantity) <= quantityToMilli(item.returnedQuantity),
    )
    const fullCancellation = allFulfilled && noOutstandingDelivered
    const anyDelivered = updatedSnapshot.items.some(
      (item) => quantityToMilli(item.deliveredQuantity) > quantityToMilli(item.returnedQuantity),
    )
    const nextStatus = fullCancellation
      ? 'Cancelled'
      : allFulfilled
        ? 'Delivered'
        : anyDelivered
          ? 'Partially Delivered'
          : 'Processing'

    await lifecycleRepository.updateOrderStatus(client, {
      orderId: snapshot.id,
      status: nextStatus,
      ...(fullCancellation
        ? { cancelledBy: context.user.id, reason: input.reason, notes: input.notes ?? null }
        : {}),
    })
    await lifecycleRepository.insertOrderLifecycleAudit(client, {
      userId: context.user.id,
      branchId: snapshot.branchId,
      orderId: snapshot.id,
      action: fullCancellation ? 'cancelled order' : 'cancelled remaining order quantities',
      data: {
        orderNumber: snapshot.orderNumber,
        previousStatus: snapshot.status,
        status: nextStatus,
        reason: input.reason,
        notes: input.notes ?? null,
        items: cancelled,
        stockMode: snapshot.stockMode,
      },
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })
    return {
      id: snapshot.id,
      orderNumber: snapshot.orderNumber,
      status: nextStatus,
      cancelledItems: cancelled,
    }
  })
}

async function loadSnapshot(client: PoolClient, orderId: string, user: AuthenticatedUser) {
  const order = await lifecycleRepository.lockOrder(client, orderId)
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'The requested order was not found.')
  const branchScope = getAssignedBranchScope(user)
  if (branchScope && order.branchId !== branchScope) {
    throw new AppError(404, 'ORDER_NOT_FOUND', 'The requested order was not found.')
  }
  await lifecycleRepository.lockOrderItems(client, orderId)
  const snapshot = await lifecycleRepository.getOrderLifecycleSnapshot(client, orderId)
  if (!snapshot) throw new AppError(404, 'ORDER_NOT_FOUND', 'The requested order was not found.')
  return snapshot
}

function requirePermission(user: AuthenticatedUser, permission: string, message: string) {
  if (!user.permissions.includes(permission)) throw new AppError(403, 'FORBIDDEN', message)
}
