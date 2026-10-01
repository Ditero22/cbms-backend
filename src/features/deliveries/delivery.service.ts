import { randomUUID } from 'node:crypto'
import { withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import { formatQuantityMilli, quantityToMilli } from '@/features/orders/order.money.js'
import * as orderLifecycleRepository from '@/features/orders/order-lifecycle.repository.js'
import { assertLegacyDeliveriesVerified } from '@/features/orders/legacy-delivery.service.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import * as deliveryRepository from './delivery.repository.js'
import { canTransitionDeliveryStatus } from './delivery.transitions.js'
import {
  createAssignmentInTransaction,
  transitionDeliveryAssignment,
} from '@/features/fleet/assignment.service.js'
import type { FleetContext } from '@/features/fleet/fleet.repository.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

type DeliveryRequestContext = {
  userId: string
  branchId: string | null
  isCrossBranch: boolean
  ipAddress: string | null
  requestId: string | null
  permissions?: string[]
}

type CreateDeliveryInput = {
  orderId: string
  destination: string
  driverName?: string | undefined
  scheduledAt?: string | undefined
  items: { orderItemId: string; quantity: string }[]
  driverId?: string | undefined
  vehicleId?: string | undefined
  startOdometer?: string | undefined
}

function fleetContext(context: DeliveryRequestContext): FleetContext {
  return {
    user: {
      id: context.userId,
      branchId: context.branchId,
      isCrossBranch: context.isCrossBranch,
      permissions: context.permissions ?? [],
      name: '',
      email: '',
      branch: '',
      role: '',
    },
    ipAddress: context.ipAddress,
    requestId: context.requestId,
  }
}

export function getDeliveryFormOptions(
  context: Pick<DeliveryRequestContext, 'branchId' | 'isCrossBranch'>,
) {
  return deliveryRepository.getDeliveryOptions(getAssignedBranchScope(context))
}

export async function getDeliveryDetail(
  deliveryId: string,
  user: AuthenticatedUser,
  historyPage = 1,
) {
  if (!user.permissions.includes('deliveries.read')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view deliveries.')
  }
  const branchScope = getAssignedBranchScope(user)
  return withTransaction(async (client) => {
    await client.query('set transaction isolation level repeatable read read only')
    const delivery = await deliveryRepository.findDeliveryDetail(client, deliveryId, branchScope)
    if (!delivery) throw new AppError(404, 'DELIVERY_NOT_FOUND', 'Delivery not found.')
    const items = await deliveryRepository.getDeliveryDetailItems(client, deliveryId)
    const history = user.permissions.includes('audit.read')
      ? await deliveryRepository.getDeliveryHistory(client, deliveryId, branchScope, historyPage)
      : { history: [], historyTotal: 0 }
    return {
      ...delivery,
      scheduledAt: delivery.scheduledAt?.toISOString() ?? null,
      allocationVerifiedAt: delivery.allocationVerifiedAt?.toISOString() ?? null,
      assignmentStartedAt: delivery.assignmentStartedAt?.toISOString() ?? null,
      assignmentEndedAt: delivery.assignmentEndedAt?.toISOString() ?? null,
      createdAt: delivery.createdAt.toISOString(),
      updatedAt: delivery.updatedAt.toISOString(),
      items,
      ...history,
      historyPage,
      historyPageSize: 25,
    }
  })
}

export async function createDelivery(input: CreateDeliveryInput, context: DeliveryRequestContext) {
  return withTransaction(async (client) => {
    const order = await orderLifecycleRepository.lockOrder(client, input.orderId)
    if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Choose an existing order.')
    if (!context.isCrossBranch && (!context.branchId || context.branchId !== order.branchId)) {
      throw new AppError(
        403,
        'BRANCH_FORBIDDEN',
        'You can only schedule deliveries for your branch.',
      )
    }
    if (order.status === 'Cancelled' || order.status === 'Completed') {
      throw new AppError(409, 'ORDER_CLOSED', 'A delivery cannot be scheduled for a closed order.')
    }
    await assertLegacyDeliveriesVerified(client, order.id)

    await orderLifecycleRepository.lockOrderItems(client, order.id)
    const snapshot = await orderLifecycleRepository.getOrderLifecycleSnapshot(client, order.id)
    if (!snapshot) throw new AppError(404, 'ORDER_NOT_FOUND', 'Choose an existing order.')
    if (snapshot.hasActiveDelivery) {
      throw new AppError(
        409,
        'DELIVERY_EXISTS',
        'Finish or fail the active delivery before scheduling another.',
      )
    }
    if (snapshot.pendingReturnCount > 0) {
      throw new AppError(
        409,
        'RETURN_PENDING',
        'Resolve the pending return before scheduling another delivery.',
      )
    }

    const itemMap = new Map(snapshot.items.map((item) => [item.id, item]))
    const deliveryReference = createDeliveryReference()
    const status = input.scheduledAt ? 'Scheduled' : 'Preparing'
    const deliveryId = await deliveryRepository.insertDelivery(client, {
      reference: deliveryReference,
      orderId: order.id,
      destination: input.destination,
      driverName: input.driverName || null,
      scheduledAt: input.scheduledAt ?? null,
      status,
    })
    if (!deliveryId) throw new Error('The delivery could not be scheduled.')
    if (input.driverId && input.vehicleId) {
      const assignment = await createAssignmentInTransaction(
        client,
        {
          vehicleId: input.vehicleId,
          driverId: input.driverId,
          branchId: order.branchId,
          deliveryId,
          destination: input.destination,
          purpose: `Delivery ${deliveryReference}`,
          ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
          ...(input.startOdometer ? { startOdometer: input.startOdometer } : {}),
        },
        fleetContext(context),
        true,
      )
      await client.query('update deliveries set driver_name=$2 where id=$1', [
        deliveryId,
        assignment.driverName,
      ])
    }

    const items = [...input.items].sort((left, right) => {
      const leftProduct = itemMap.get(left.orderItemId)?.productId ?? ''
      const rightProduct = itemMap.get(right.orderItemId)?.productId ?? ''
      return (
        leftProduct.localeCompare(rightProduct) || left.orderItemId.localeCompare(right.orderItemId)
      )
    })
    for (const requestedItem of items) {
      const item = itemMap.get(requestedItem.orderItemId)
      if (!item) throw new AppError(404, 'ORDER_ITEM_NOT_FOUND', 'Choose an item on this order.')

      const ordered = quantityToMilli(item.quantity)
      const cancelled = quantityToMilli(item.cancelledQuantity)
      const delivered = quantityToMilli(item.deliveredQuantity)
      const returned = quantityToMilli(item.returnedQuantity)
      const remaining = ordered - cancelled - delivered + returned
      const requested = quantityToMilli(requestedItem.quantity)
      if (requested > remaining) {
        throw new AppError(
          409,
          'DELIVERY_EXCEEDS_REMAINING',
          `${item.productName} has only ${formatQuantityMilli(remaining)} ${item.unit} remaining for delivery.`,
          { orderItemId: item.id, remainingQuantity: formatQuantityMilli(remaining) },
        )
      }

      if (snapshot.stockMode === 'LegacyConsumed') {
        await orderLifecycleRepository.allocateReservationToDeliveryItem(client, {
          deliveryId,
          orderItemId: item.id,
          reservationId: null,
          quantity: formatQuantityMilli(requested),
        })
        continue
      }

      let unallocated = requested
      const reservations = await orderLifecycleRepository.getReservationRowsForUpdate(
        client,
        item.id,
      )
      for (const reservation of reservations) {
        const available =
          quantityToMilli(reservation.quantity) -
          quantityToMilli(reservation.fulfilledQuantity) -
          quantityToMilli(reservation.releasedQuantity) -
          quantityToMilli(reservation.pendingQuantity)
        if (available <= 0n || unallocated <= 0n) continue
        const allocated = available < unallocated ? available : unallocated
        await orderLifecycleRepository.allocateReservationToDeliveryItem(client, {
          deliveryId,
          orderItemId: item.id,
          reservationId: reservation.id,
          quantity: formatQuantityMilli(allocated),
        })
        unallocated -= allocated
      }

      if (unallocated > 0n) {
        const stock = await orderLifecycleRepository.lockInventory(
          client,
          item.productId,
          order.branchId,
        )
        if (
          !stock ||
          quantityToMilli(stock.quantity) - quantityToMilli(stock.reservedQuantity) < unallocated
        ) {
          throw new AppError(
            409,
            'INSUFFICIENT_STOCK',
            `There is not enough available stock to schedule ${item.productName}.`,
            { productId: item.productId, requiredQuantity: formatQuantityMilli(unallocated) },
          )
        }
        const addedReservation = await orderLifecycleRepository.adjustInventoryReservation(client, {
          productId: item.productId,
          branchId: order.branchId,
          quantityDelta: formatQuantityMilli(unallocated),
        })
        if (!addedReservation) {
          throw new AppError(
            409,
            'INSUFFICIENT_STOCK',
            'Stock changed while scheduling this delivery.',
          )
        }
        const reservationId = await orderLifecycleRepository.insertOrderReservation(client, {
          orderItemId: item.id,
          quantity: formatQuantityMilli(unallocated),
          createdBy: context.userId,
        })
        if (!reservationId) throw new Error('The additional stock reservation could not be saved.')
        await orderLifecycleRepository.allocateReservationToDeliveryItem(client, {
          deliveryId,
          orderItemId: item.id,
          reservationId,
          quantity: formatQuantityMilli(unallocated),
        })
        await orderLifecycleRepository.insertLifecycleInventoryMovement(client, {
          productId: item.productId,
          branchId: order.branchId,
          transactionType: 'RESERVATION_CREATED',
          quantityDelta: formatQuantityMilli(unallocated),
          orderId: order.id,
          note: `Additional stock reserved for delivery ${deliveryReference}`,
          performedBy: context.userId,
        })
      }
    }

    await deliveryRepository.insertDeliveryAuditLog(client, {
      userId: context.userId,
      branchId: order.branchId,
      deliveryId,
      reference: deliveryReference,
      action: 'created delivery',
      data: {
        orderId: order.id,
        destination: input.destination,
        driverName: input.driverName || null,
        scheduledAt: input.scheduledAt ?? null,
        status,
        items: input.items,
      },
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })
    await orderLifecycleRepository.insertOrderLifecycleAudit(client, {
      userId: context.userId,
      branchId: order.branchId,
      orderId: order.id,
      action: 'created delivery',
      data: { deliveryId, deliveryReference, items: input.items },
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })

    return { id: deliveryId, reference: deliveryReference, status }
  })
}

export async function updateDeliveryStatus(
  deliveryId: string,
  status: string,
  context: DeliveryRequestContext,
  assignmentInput: { endOdometer?: string | undefined; notes?: string | undefined } = {},
) {
  return withTransaction(async (client) => {
    const orderId = await deliveryRepository.getOrderIdForDelivery(client, deliveryId)
    if (!orderId)
      throw new AppError(404, 'DELIVERY_NOT_FOUND', 'The requested delivery was not found.')
    const order = await orderLifecycleRepository.lockOrder(client, orderId)
    if (!order)
      throw new AppError(404, 'ORDER_NOT_FOUND', 'The order for this delivery was not found.')
    if (!context.isCrossBranch && (!context.branchId || context.branchId !== order.branchId)) {
      throw new AppError(403, 'BRANCH_FORBIDDEN', 'You can only update deliveries for your branch.')
    }
    if (order.status === 'Cancelled' || order.status === 'Completed') {
      throw new AppError(409, 'ORDER_CLOSED', 'Deliveries cannot be changed on a closed order.')
    }
    await assertLegacyDeliveriesVerified(client, order.id)

    const delivery = await deliveryRepository.findDeliveryForUpdate(client, deliveryId)
    if (!delivery)
      throw new AppError(404, 'DELIVERY_NOT_FOUND', 'The requested delivery was not found.')
    if (!canTransitionDeliveryStatus(delivery.status, status)) {
      throw new AppError(
        409,
        'INVALID_DELIVERY_TRANSITION',
        `A delivery cannot move from ${delivery.status} to ${status}.`,
      )
    }

    if (status === 'Delivered') {
      const items = await orderLifecycleRepository.getDeliveryItems(client, delivery.id)
      if (items.length === 0) {
        throw new AppError(
          409,
          'DELIVERY_ITEMS_MISSING',
          'This delivery has no recorded order items.',
        )
      }
      for (const item of items) {
        if (order.stockMode === 'LegacyConsumed') continue
        if (!item.reservationId) {
          throw new AppError(
            409,
            'RESERVATION_MISSING',
            'A delivery line is missing its stock reservation.',
          )
        }
        const fulfilled = await orderLifecycleRepository.markReservationFulfilled(
          client,
          item.reservationId,
          item.quantity,
        )
        const stock = fulfilled
          ? await orderLifecycleRepository.deliverReservedInventory(client, {
              productId: item.productId,
              branchId: order.branchId,
              quantity: item.quantity,
            })
          : undefined
        if (!fulfilled || !stock) {
          throw new AppError(
            409,
            'RESERVATION_UNAVAILABLE',
            'The reserved quantity is no longer available. No delivery or inventory changes were saved.',
            { productId: item.productId },
          )
        }
        await orderLifecycleRepository.insertLifecycleInventoryMovement(client, {
          productId: item.productId,
          branchId: order.branchId,
          transactionType: 'DELIVERY_OUT',
          quantityDelta: formatQuantityMilli(-quantityToMilli(item.quantity)),
          orderId: order.id,
          note: `Delivered on ${delivery.reference}`,
          performedBy: context.userId,
        })
      }
    }

    await transitionDeliveryAssignment(
      client,
      delivery.id,
      status,
      fleetContext(context),
      assignmentInput,
    )
    await deliveryRepository.updateDeliveryStatus(client, delivery.id, status)
    await deliveryRepository.insertDeliveryAuditLog(client, {
      userId: context.userId,
      branchId: delivery.branchId,
      deliveryId: delivery.id,
      reference: delivery.reference,
      action: 'updated delivery status',
      data: { oldStatus: delivery.status, status },
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })

    let nextOrderStatus = order.status
    if (status === 'Delivered') {
      const snapshot = await orderLifecycleRepository.getOrderLifecycleSnapshot(client, order.id)
      if (!snapshot) throw new AppError(404, 'ORDER_NOT_FOUND', 'The order was not found.')
      const itemStates = snapshot.items.map((item) => ({
        fulfilled:
          quantityToMilli(item.deliveredQuantity) -
          quantityToMilli(item.returnedQuantity) +
          quantityToMilli(item.cancelledQuantity),
        ordered: quantityToMilli(item.quantity),
      }))
      if (itemStates.some((item) => item.fulfilled > 0n)) nextOrderStatus = 'Partially Delivered'
      if (itemStates.every((item) => item.fulfilled >= item.ordered)) nextOrderStatus = 'Delivered'
      await orderLifecycleRepository.updateOrderStatus(client, {
        orderId: order.id,
        status: nextOrderStatus,
      })
      await orderLifecycleRepository.insertOrderLifecycleAudit(client, {
        userId: context.userId,
        branchId: order.branchId,
        orderId: order.id,
        action: 'confirmed order delivery',
        data: {
          deliveryId: delivery.id,
          deliveryReference: delivery.reference,
          previousStatus: order.status,
          status: nextOrderStatus,
        },
        ipAddress: context.ipAddress,
        requestId: context.requestId,
      })
    }

    return { id: delivery.id, reference: delivery.reference, status }
  })
}

function createDeliveryReference() {
  return `DLV-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`
}
