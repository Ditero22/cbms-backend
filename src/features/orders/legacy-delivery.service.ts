import type { PoolClient } from 'pg'
import { withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { formatQuantityMilli, quantityToMilli } from './order.money.js'
import * as lifecycleRepository from './order-lifecycle.repository.js'
import * as repository from './legacy-delivery.repository.js'
import type { ReconcileLegacyDeliveryInput } from './legacy-delivery.schemas.js'

type ReconciliationContext = {
  user: AuthenticatedUser
  ipAddress: string | null
  requestId: string | null
}

export type LegacyDeliveryReconciliation = {
  orderId: string
  stockMode: 'LegacyConsumed' | 'Reserved'
  requiresReconciliation: boolean
  deliveries: {
    id: string
    reference: string
    status: string
    allocationOrigin: 'Recorded' | 'LegacyBackfill'
    allocationStatus: 'Verified' | 'Unverified'
    allocationVerifiedAt: string | null
    allocationVerifiedBy: string | null
    items: {
      orderItemId: string
      productName: string
      sku: string
      unit: string
      orderedQuantity: string
      cancelledQuantity: string
      quantity: string
      inferredQuantity: string | null
    }[]
  }[]
}

export type ReconcileLegacyDeliveryResponse = LegacyDeliveryReconciliation['deliveries'][number] & {
  orderId: string
  deliveryId: string
  requiresReconciliation: boolean
}

export async function assertLegacyDeliveriesVerified(client: PoolClient, orderId: string) {
  const unverified = await repository.findUnverifiedLegacyDelivery(client, orderId)
  if (unverified) {
    throw new AppError(
      409,
      'LEGACY_DELIVERY_RECONCILIATION_REQUIRED',
      `Verify the historical quantities on delivery ${unverified.reference} before continuing.`,
    )
  }
}

export async function getLegacyDeliveryReconciliation(
  orderId: string,
  user: AuthenticatedUser,
): Promise<LegacyDeliveryReconciliation> {
  requirePermission(user)
  return withTransaction(async (client) => {
    const order = await findOrderInScope(client, orderId, user, false)
    return getReconciliationView(client, order)
  })
}

export async function reconcileLegacyDelivery(
  orderId: string,
  deliveryId: string,
  input: ReconcileLegacyDeliveryInput,
  context: ReconciliationContext,
): Promise<ReconcileLegacyDeliveryResponse> {
  requirePermission(context.user)
  return withTransaction(async (client) => {
    const order = await findOrderInScope(client, orderId, context.user, true)
    if (order.stockMode !== 'LegacyConsumed') {
      throw new AppError(
        409,
        'ORDER_NOT_LEGACY',
        'This order does not need legacy delivery reconciliation.',
      )
    }
    await repository.lockOrderLines(client, orderId)
    const delivery = await repository.lockDelivery(client, orderId, deliveryId)
    if (!delivery)
      throw new AppError(404, 'DELIVERY_NOT_FOUND', 'This delivery is not on the order.')
    if (delivery.allocationOrigin !== 'LegacyBackfill' || delivery.status === 'Failed') {
      throw new AppError(
        409,
        'DELIVERY_NOT_RECONCILABLE',
        'Only an inferred historical delivery allocation can be reconciled.',
      )
    }

    const orderLines = await repository.getOrderLines(client, orderId)
    const oldRows = await repository.lockDeliveryAllocations(client, deliveryId)
    const otherRows = await repository.getOtherAllocations(client, orderId, deliveryId)
    const deliveries = await repository.getDeliveries(client, orderId)
    const orderLineMap = new Map(orderLines.map((line) => [line.orderItemId, line]))
    const requestedMap = new Map(input.items.map((item) => [item.orderItemId, item.quantity]))
    if (
      orderLines.length === 0 ||
      requestedMap.size !== orderLines.length ||
      input.items.length !== orderLines.length ||
      input.items.some((item) => !orderLineMap.has(item.orderItemId))
    ) {
      throw new AppError(
        400,
        'RECONCILIATION_LINES_INVALID',
        'Provide a quantity for every line on this order, including zero for items not in the delivery.',
      )
    }
    if (oldRows.some((row) => !orderLineMap.has(row.orderItemId) || row.reservationId)) {
      throw new AppError(
        409,
        'DELIVERY_ALLOCATION_MISMATCH',
        'This delivery contains an allocation that needs manual review.',
      )
    }

    const oldQuantity = new Map<string, bigint>()
    const oldInferredQuantity = new Map<string, bigint>()
    for (const row of oldRows) {
      oldQuantity.set(
        row.orderItemId,
        (oldQuantity.get(row.orderItemId) ?? 0n) + quantityToMilli(row.quantity),
      )
      if (row.inferredQuantity !== null) {
        oldInferredQuantity.set(
          row.orderItemId,
          (oldInferredQuantity.get(row.orderItemId) ?? 0n) + quantityToMilli(row.inferredQuantity),
        )
      }
    }
    const anotherUnverifiedDelivery = deliveries.some(
      (candidate) => candidate.id !== deliveryId && candidate.allocationStatus === 'Unverified',
    )
    const otherQuantity = new Map(
      otherRows.map((row) => [
        row.orderItemId,
        quantityToMilli(anotherUnverifiedDelivery ? row.verifiedQuantity : row.quantity),
      ]),
    )
    const corrected = orderLines.some(
      (line) =>
        quantityToMilli(requestedMap.get(line.orderItemId) ?? '0') !==
        (oldQuantity.get(line.orderItemId) ?? 0n),
    )
    for (const line of orderLines) {
      const requested = quantityToMilli(requestedMap.get(line.orderItemId) ?? '0')
      const alreadyElsewhere = otherQuantity.get(line.orderItemId) ?? 0n
      if (
        requested + alreadyElsewhere >
        quantityToMilli(line.orderedQuantity) - quantityToMilli(line.cancelledQuantity)
      ) {
        throw new AppError(
          409,
          'DELIVERY_OVERALLOCATED',
          `${line.productName} exceeds its order quantity across deliveries.`,
          {
            orderItemId: line.orderItemId,
            maximum: formatQuantityMilli(
              quantityToMilli(line.orderedQuantity) -
                quantityToMilli(line.cancelledQuantity) -
                alreadyElsewhere,
            ),
          },
        )
      }
    }

    if (delivery.allocationStatus === 'Verified') {
      if (corrected) {
        throw new AppError(
          409,
          'DELIVERY_ALREADY_VERIFIED',
          'This historical allocation is already verified. Further corrections need a separate review.',
        )
      }
      return responseForDelivery(await getReconciliationView(client, order), deliveryId)
    }

    const hasReturnHistory = await repository.hasOrderReturnHistory(client, orderId)
    if (
      corrected &&
      (hasReturnHistory ||
        orderLines.some((line) => quantityToMilli(line.cancelledQuantity) > 0n) ||
        ['Completed', 'Cancelled'].includes(order.status) ||
        (await repository.hasDeliveryStockMovement(client, orderId)))
    ) {
      throw new AppError(
        409,
        'HISTORICAL_ALLOCATION_REQUIRES_MANUAL_REVIEW',
        'This order has returns, cancellations, a closed status, or stock movements tied to its existing quantities. Confirm the recorded quantities or resolve those transactions through a separate reviewed correction.',
      )
    }

    if (corrected) {
      await repository.replaceDeliveryAllocations(
        client,
        deliveryId,
        orderLines.map((line) => ({
          orderItemId: line.orderItemId,
          quantity: formatQuantityMilli(quantityToMilli(requestedMap.get(line.orderItemId) ?? '0')),
          inferredQuantity: oldInferredQuantity.has(line.orderItemId)
            ? formatQuantityMilli(oldInferredQuantity.get(line.orderItemId)!)
            : null,
        })),
      )
    }
    await repository.markDeliveryVerified(client, deliveryId, context.user.id)

    const view = await getReconciliationView(client, order)
    let nextOrderStatus = order.status
    if (
      !view.requiresReconciliation &&
      !['Completed', 'Cancelled'].includes(order.status) &&
      !hasReturnHistory &&
      orderLines.every((line) => quantityToMilli(line.cancelledQuantity) === 0n)
    ) {
      const snapshot = await lifecycleRepository.getOrderLifecycleSnapshot(client, orderId)
      if (!snapshot) throw new Error('The order disappeared during reconciliation.')
      const allDelivered = snapshot.items.every(
        (item) => quantityToMilli(item.deliveredQuantity) >= quantityToMilli(item.quantity),
      )
      const anyDelivered = snapshot.items.some(
        (item) => quantityToMilli(item.deliveredQuantity) > 0n,
      )
      nextOrderStatus = allDelivered
        ? 'Delivered'
        : anyDelivered
          ? 'Partially Delivered'
          : 'Processing'
      if (nextOrderStatus !== order.status) {
        await repository.setOrderStatus(client, orderId, nextOrderStatus)
      }
    }

    await repository.insertReconciliationAudit(client, {
      userId: context.user.id,
      branchId: order.branchId,
      deliveryId,
      oldValue: {
        orderId,
        orderStatus: order.status,
        allocationStatus: delivery.allocationStatus,
        items: oldRows.map((row) => ({
          orderItemId: row.orderItemId,
          quantity: row.quantity,
          inferredQuantity: row.inferredQuantity,
        })),
      },
      newValue: {
        orderId,
        orderStatus: nextOrderStatus,
        allocationStatus: 'Verified',
        corrected,
        note: input.note,
        items: orderLines.map((line) => ({
          orderItemId: line.orderItemId,
          quantity: formatQuantityMilli(quantityToMilli(requestedMap.get(line.orderItemId) ?? '0')),
        })),
      },
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })
    return responseForDelivery(view, deliveryId)
  })
}

async function findOrderInScope(
  client: PoolClient,
  orderId: string,
  user: AuthenticatedUser,
  lock: boolean,
) {
  const order = await repository.findOrder(client, orderId, lock)
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'The requested order was not found.')
  const branchId = getAssignedBranchScope(user)
  if (branchId && branchId !== order.branchId) {
    throw new AppError(404, 'ORDER_NOT_FOUND', 'The requested order was not found.')
  }
  return order
}

async function getReconciliationView(
  client: PoolClient,
  order: NonNullable<Awaited<ReturnType<typeof repository.findOrder>>>,
): Promise<LegacyDeliveryReconciliation> {
  const orderLines = await repository.getOrderLines(client, order.id)
  const deliveries = await repository.getDeliveries(client, order.id)
  const allocations = await repository.getDeliveryAllocations(client, order.id)
  return {
    orderId: order.id,
    stockMode: order.stockMode,
    requiresReconciliation:
      order.stockMode === 'LegacyConsumed' &&
      deliveries.some((delivery) => delivery.allocationStatus === 'Unverified'),
    deliveries: deliveries.map((delivery) => ({
      ...delivery,
      allocationVerifiedAt: delivery.allocationVerifiedAt?.toISOString() ?? null,
      items: orderLines.map((line) => {
        const rows = allocations.filter(
          (allocation) =>
            allocation.deliveryId === delivery.id && allocation.orderItemId === line.orderItemId,
        )
        const inferred = rows.filter((row) => row.inferredQuantity !== null)
        return {
          ...line,
          quantity: formatQuantityMilli(
            rows.reduce((total, row) => total + quantityToMilli(row.quantity), 0n),
          ),
          inferredQuantity: inferred.length
            ? formatQuantityMilli(
                inferred.reduce((total, row) => total + quantityToMilli(row.inferredQuantity!), 0n),
              )
            : null,
        }
      }),
    })),
  }
}

function responseForDelivery(
  view: LegacyDeliveryReconciliation,
  deliveryId: string,
): ReconcileLegacyDeliveryResponse {
  const delivery = view.deliveries.find((candidate) => candidate.id === deliveryId)
  if (!delivery) throw new Error('The reconciled delivery disappeared.')
  return {
    orderId: view.orderId,
    deliveryId,
    requiresReconciliation: view.requiresReconciliation,
    ...delivery,
  }
}

function requirePermission(user: AuthenticatedUser) {
  if (!user.permissions.includes('deliveries.update')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to reconcile deliveries.')
  }
}
