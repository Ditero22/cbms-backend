import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import { formatQuantityMilli, quantityToMilli } from './order.money.js'
import * as orderLifecycleRepository from './order-lifecycle.repository.js'
import { assertLegacyDeliveriesVerified } from './legacy-delivery.service.js'
import * as returnRepository from './return.repository.js'
import type { ReceiveReturnInput } from './return.schemas.js'

type ReturnContext = {
  user: AuthenticatedUser
  ipAddress: string | null
  requestId: string | null
}

export async function listOrderReturns(orderId: string, user: AuthenticatedUser) {
  requirePermission(user, 'sales.read')
  return withTransaction(async (client) => {
    const order = await lockOrderInScope(client, orderId, user)
    return returnRepository.listOrderReturns(client, order.id)
  })
}

export async function requestReturn(
  orderId: string,
  input: {
    requestKey: string
    deliveryId: string
    reason: string
    notes?: string | undefined
    items: { orderItemId: string; quantity: string }[]
  },
  context: ReturnContext,
) {
  requirePermission(context.user, 'returns.create')
  return withTransaction(async (client) => {
    const order = await lockOrderInScope(client, orderId, context.user)
    await assertLegacyDeliveriesVerified(client, order.id)
    await orderLifecycleRepository.lockOrderItems(client, order.id)
    const existing = await returnRepository.findReturnByRequestKey(client, input.requestKey)
    if (existing) {
      if (
        existing.orderId !== order.id ||
        existing.deliveryId !== input.deliveryId ||
        existing.reason !== input.reason ||
        existing.notes !== (input.notes ?? null)
      ) {
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'This return request key was already used for different details.',
        )
      }
      const existingItems = await returnRepository.getReturnItemsForUpdate(client, existing.id)
      const requestedItems = new Map(
        input.items.map((item) => [item.orderItemId, quantityToMilli(item.quantity)]),
      )
      if (
        existingItems.length !== requestedItems.size ||
        existingItems.some(
          (item) => requestedItems.get(item.orderItemId) !== quantityToMilli(item.quantity),
        )
      ) {
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'This return request key was already used for different item quantities.',
        )
      }
      return { id: existing.id, reference: existing.reference, status: existing.status }
    }

    const delivery = await returnRepository.findDeliveryForReturn(
      client,
      order.id,
      input.deliveryId,
    )
    if (!delivery || delivery.status !== 'Delivered') {
      throw new AppError(
        409,
        'DELIVERY_NOT_RETURNABLE',
        'Returns can only be requested for a completed delivery on this order.',
      )
    }
    const deliveredItems = await returnRepository.getDeliveryItemQuantities(client, delivery.id)
    const itemMap = new Map(
      deliveredItems.map((item) => [item.orderItemId, quantityToMilli(item.quantity)]),
    )
    const returnedItems = new Map(
      (await returnRepository.getDeliveryReturnQuantities(client, delivery.id)).map((item) => [
        item.orderItemId,
        quantityToMilli(item.returned) + quantityToMilli(item.pending),
      ]),
    )
    const snapshot = await orderLifecycleRepository.getOrderLifecycleSnapshot(client, order.id)
    if (!snapshot) throw new AppError(404, 'ORDER_NOT_FOUND', 'The requested order was not found.')
    const orderItems = new Map(snapshot.items.map((item) => [item.id, item]))
    const orderReturned = new Map(
      (await returnRepository.getReturnedQuantities(client, order.id)).map((item) => [
        item.orderItemId,
        quantityToMilli(item.received) + quantityToMilli(item.pending),
      ]),
    )

    for (const requested of input.items) {
      const deliveredOnThisShipment = itemMap.get(requested.orderItemId)
      const item = orderItems.get(requested.orderItemId)
      if (deliveredOnThisShipment === undefined || !item) {
        throw new AppError(
          404,
          'DELIVERED_ITEM_NOT_FOUND',
          'Choose an item included in this delivery.',
        )
      }
      const requestedMilli = quantityToMilli(requested.quantity)
      const alreadyOnThisShipment = returnedItems.get(requested.orderItemId) ?? 0n
      if (requestedMilli > deliveredOnThisShipment - alreadyOnThisShipment) {
        throw new AppError(
          409,
          'RETURN_EXCEEDS_DELIVERED_QUANTITY',
          `${item.productName} has less quantity available on this delivery.`,
          {
            orderItemId: item.id,
            available: formatQuantityMilli(deliveredOnThisShipment - alreadyOnThisShipment),
          },
        )
      }
      const alreadyForOrder = orderReturned.get(requested.orderItemId) ?? 0n
      if (requestedMilli > quantityToMilli(item.deliveredQuantity) - alreadyForOrder) {
        throw new AppError(
          409,
          'RETURN_EXCEEDS_DELIVERED_QUANTITY',
          `${item.productName} has already been returned or has a return pending.`,
          {
            orderItemId: item.id,
            available: formatQuantityMilli(
              quantityToMilli(item.deliveredQuantity) - alreadyForOrder,
            ),
          },
        )
      }
    }

    const reference = `RET-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`
    const returnId = await returnRepository.insertReturn(client, {
      reference,
      requestKey: input.requestKey,
      orderId: order.id,
      deliveryId: delivery.id,
      reason: input.reason,
      notes: input.notes ?? null,
      requestedBy: context.user.id,
    })
    if (!returnId) throw new Error('The return request could not be saved.')
    for (const item of input.items) {
      await returnRepository.insertReturnItem(client, {
        returnId,
        orderItemId: item.orderItemId,
        quantity: formatQuantityMilli(quantityToMilli(item.quantity)),
      })
    }
    await returnRepository.insertReturnAudit(client, {
      userId: context.user.id,
      branchId: order.branchId,
      returnId,
      action: 'requested order return',
      payload: {
        reference,
        orderId: order.id,
        deliveryId: delivery.id,
        reason: input.reason,
        items: input.items,
      },
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })
    return { id: returnId, reference, status: 'Requested' }
  })
}

export async function approveReturn(returnId: string, context: ReturnContext) {
  requirePermission(context.user, 'returns.approve')
  return transitionReturn(returnId, context, 'Requested', 'Approved')
}

export async function rejectReturn(returnId: string, reason: string, context: ReturnContext) {
  requirePermission(context.user, 'returns.approve')
  return transitionReturn(returnId, context, 'Requested', 'Rejected', reason)
}

export async function receiveReturn(
  returnId: string,
  input: ReceiveReturnInput,
  context: ReturnContext,
) {
  requirePermission(context.user, 'returns.receive')
  return withTransaction(async (client) => {
    const orderId = await returnRepository.findReturnOrderId(client, returnId)
    if (!orderId) throw new AppError(404, 'RETURN_NOT_FOUND', 'The return request was not found.')
    const order = await lockOrderInScope(client, orderId, context.user)
    await assertLegacyDeliveriesVerified(client, order.id)
    await orderLifecycleRepository.lockOrderItems(client, order.id)
    const returnRecord = await returnRepository.findReturnForUpdate(client, returnId)
    if (!returnRecord)
      throw new AppError(404, 'RETURN_NOT_FOUND', 'The return request was not found.')
    if (returnRecord.status !== 'Approved') {
      throw new AppError(409, 'RETURN_NOT_APPROVED', 'Only an approved return can be received.')
    }
    const returnItems = await returnRepository.getReturnItemsForUpdate(client, returnId)
    const receiveMap = new Map(input.items.map((item) => [item.orderItemId, item]))
    if (
      receiveMap.size !== returnItems.length ||
      returnItems.some((item) => !receiveMap.has(item.orderItemId))
    ) {
      throw new AppError(
        400,
        'RETURN_CLASSIFICATION_REQUIRED',
        'Classify every item on the return before receiving it.',
      )
    }
    for (const item of returnItems) {
      const classification = receiveMap.get(item.orderItemId)
      if (!classification) throw new Error('Return classification disappeared during validation.')
      const accepted = quantityToMilli(classification.acceptedQuantity)
      const returnedQuantity = quantityToMilli(item.quantity)
      if (accepted > returnedQuantity) {
        throw new AppError(
          400,
          'ACCEPTED_QUANTITY_EXCEEDS_RETURN',
          `${item.productName} accepted quantity cannot exceed the return quantity.`,
        )
      }
      const hasNonResalableRemainder = accepted < returnedQuantity
      const hasRemainderCondition = Boolean(classification.remainderCondition)
      if (
        (classification.condition === 'Resalable' &&
          hasNonResalableRemainder !== hasRemainderCondition) ||
        (classification.condition !== 'Resalable' &&
          (accepted !== 0n || classification.remainderCondition !== undefined))
      ) {
        throw new AppError(
          400,
          'RETURN_REMAINDER_CONDITION_INVALID',
          'Classify the non-resalable remainder only when part of a return is accepted into stock.',
        )
      }
      const updated = await returnRepository.classifyReturnItem(client, {
        returnId,
        orderItemId: item.orderItemId,
        condition: classification.condition,
        acceptedQuantity: formatQuantityMilli(accepted),
        remainderCondition: classification.remainderCondition ?? null,
      })
      if (!updated)
        throw new AppError(
          409,
          'RETURN_ITEM_CHANGED',
          'A return item could not be classified safely.',
        )
      if (accepted > 0n) {
        const stock = await orderLifecycleRepository.restockInventory(client, {
          productId: item.productId,
          branchId: order.branchId,
          quantity: formatQuantityMilli(accepted),
        })
        if (!stock) throw new Error('Accepted returned stock could not be restored.')
        await returnRepository.insertReturnInventoryMovement(client, {
          productId: item.productId,
          branchId: order.branchId,
          quantity: formatQuantityMilli(accepted),
          returnId,
          note: `Resalable goods received from return ${returnRecord.reference}`,
          userId: context.user.id,
        })
      }
    }
    const changed = await returnRepository.transitionReturn(client, {
      returnId,
      from: 'Approved',
      to: 'Received',
      userId: context.user.id,
    })
    if (!changed)
      throw new AppError(
        409,
        'RETURN_STATE_CHANGED',
        'The return status changed. Refresh and try again.',
      )
    let nextOrderStatus = order.status
    if (order.status !== 'Completed' && order.status !== 'Cancelled') {
      const snapshot = await orderLifecycleRepository.getOrderLifecycleSnapshot(client, order.id)
      if (!snapshot) throw new Error('The order disappeared while receiving its return.')
      const netDelivered = snapshot.items.map(
        (item) => quantityToMilli(item.deliveredQuantity) - quantityToMilli(item.returnedQuantity),
      )
      const allFulfilled = snapshot.items.every(
        (item, index) =>
          netDelivered[index]! + quantityToMilli(item.cancelledQuantity) >=
          quantityToMilli(item.quantity),
      )
      nextOrderStatus = allFulfilled
        ? 'Delivered'
        : netDelivered.some((quantity) => quantity > 0n)
          ? 'Partially Delivered'
          : 'Processing'
      if (nextOrderStatus !== order.status) {
        await orderLifecycleRepository.updateOrderStatus(client, {
          orderId: order.id,
          status: nextOrderStatus,
        })
        await orderLifecycleRepository.insertOrderLifecycleAudit(client, {
          userId: context.user.id,
          branchId: order.branchId,
          orderId: order.id,
          action: 'updated order status after return',
          data: {
            returnId,
            previousStatus: order.status,
            status: nextOrderStatus,
          },
          ipAddress: context.ipAddress,
          requestId: context.requestId,
        })
      }
    }
    await returnRepository.insertReturnAudit(client, {
      userId: context.user.id,
      branchId: order.branchId,
      returnId,
      action: 'received order return',
      payload: {
        reference: returnRecord.reference,
        items: input.items,
        previousOrderStatus: order.status,
        orderStatus: nextOrderStatus,
      },
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })
    return { id: returnId, reference: returnRecord.reference, status: 'Received' }
  })
}

async function transitionReturn(
  returnId: string,
  context: ReturnContext,
  from: 'Requested',
  to: 'Approved' | 'Rejected',
  reason?: string,
) {
  return withTransaction(async (client) => {
    const orderId = await returnRepository.findReturnOrderId(client, returnId)
    if (!orderId) throw new AppError(404, 'RETURN_NOT_FOUND', 'The return request was not found.')
    const order = await lockOrderInScope(client, orderId, context.user)
    if (to === 'Approved') await assertLegacyDeliveriesVerified(client, order.id)
    const returnRecord = await returnRepository.findReturnForUpdate(client, returnId)
    if (!returnRecord)
      throw new AppError(404, 'RETURN_NOT_FOUND', 'The return request was not found.')
    if (returnRecord.status !== from)
      throw new AppError(
        409,
        'RETURN_STATE_CHANGED',
        `Only a ${from.toLowerCase()} return can be ${to.toLowerCase()}.`,
      )
    const changed = await returnRepository.transitionReturn(client, {
      returnId,
      from,
      to,
      userId: context.user.id,
      ...(reason === undefined ? {} : { reason }),
    })
    if (!changed)
      throw new AppError(
        409,
        'RETURN_STATE_CHANGED',
        'The return status changed. Refresh and try again.',
      )
    await returnRepository.insertReturnAudit(client, {
      userId: context.user.id,
      branchId: order.branchId,
      returnId,
      action: to === 'Approved' ? 'approved order return' : 'rejected order return',
      payload: { reference: returnRecord.reference, reason: reason ?? null },
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })
    return { id: returnId, reference: returnRecord.reference, status: to }
  })
}

async function lockOrderInScope(client: PoolClient, orderId: string, user: AuthenticatedUser) {
  const order = await orderLifecycleRepository.lockOrder(client, orderId)
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'The requested order was not found.')
  const branchScope = getAssignedBranchScope(user)
  if (branchScope && branchScope !== order.branchId) {
    throw new AppError(404, 'ORDER_NOT_FOUND', 'The requested order was not found.')
  }
  return order
}

function requirePermission(user: AuthenticatedUser, permission: string) {
  if (!user.permissions.includes(permission)) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to manage order returns.')
  }
}
