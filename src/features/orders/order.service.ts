import { randomUUID } from 'node:crypto'
import { withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import * as orderRepository from './order.repository.js'
import * as orderLifecycleRepository from './order-lifecycle.repository.js'
import { calculateOrderEligibility } from './order-lifecycle.domain.js'
import {
  calculateLineTotal,
  calculateOrderTotal,
  isOrderAmountRepresentable,
} from './order.money.js'
import { quantityToMilli, formatQuantityMilli } from '@/shared/domain/fixed-point.js'

type PlaceOrderInput = {
  customerId: string
  branchId: string
  items: { productId: string; quantity: number }[]
  requestKey?: string | undefined
}

type OrderRequestContext = {
  userId: string
  customerBranchScope: string | null
  ipAddress: string | null
  requestId: string | null
}

export function getOrderFormOptions(branchId?: string | null) {
  return orderRepository.getOrderOptions(branchId)
}

export async function getOrderDetail(orderId: string, user: AuthenticatedUser) {
  if (!user.permissions.includes('sales.read')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view orders.')
  }
  const branchId = getAssignedBranchScope(user)
  return withTransaction(async (client) => {
    // Detail, money, eligibility and audit history must describe one committed state.
    await client.query('set transaction isolation level repeatable read read only')
    const detail = await orderRepository.getOrderDetail(client, orderId, branchId)
    if (!detail) throw new AppError(404, 'ORDER_NOT_FOUND', 'The requested order was not found.')
    const snapshot = await orderLifecycleRepository.getOrderLifecycleSnapshot(client, orderId)
    if (!snapshot) throw new AppError(404, 'ORDER_NOT_FOUND', 'The requested order was not found.')
    const lifecycle = calculateOrderEligibility(snapshot)
    const auditHistory = user.permissions.includes('audit.read')
      ? await orderRepository.getOrderAuditHistory(client, orderId, branchId)
      : []

    return {
      ...detail.order,
      paidAmount: lifecycle.financial.netPaid,
      payableAmount: lifecycle.financial.orderTotal,
      balance: lifecycle.financial.balance,
      items: detail.items,
      payments: detail.payments,
      deliveries: detail.deliveries,
      stockMovements: detail.stockMovements,
      refunds: detail.refunds,
      returns: detail.returns,
      lifecycle,
      history: auditHistory,
    }
  })
}

export async function placeOrder(input: PlaceOrderInput, context: OrderRequestContext) {
  return withTransaction(async (client) => {
    const requestedItems = input.items
      .map((item) => ({
        productId: item.productId.toLowerCase(),
        quantity: formatQuantityMilli(quantityToMilli(item.quantity)),
      }))
      .sort((left, right) => left.productId.localeCompare(right.productId))

    if (input.requestKey) {
      await orderRepository.lockOrderCreateRequest(client, input.requestKey)
      const existing = await orderRepository.findOrderCreateRequest(client, input.requestKey)
      if (existing) {
        const existingItems = existing.items
          .map((item) => ({
            productId: item.productId.toLowerCase(),
            quantity: formatQuantityMilli(quantityToMilli(item.quantity)),
          }))
          .sort((left, right) => left.productId.localeCompare(right.productId))
        const sameIntent =
          existing.createdBy === context.userId &&
          existing.customerId === input.customerId &&
          existing.branchId === input.branchId &&
          JSON.stringify(existingItems) === JSON.stringify(requestedItems)
        if (!sameIntent) {
          throw new AppError(
            409,
            'REQUEST_KEY_CONFLICT',
            'This order request key was already used with different values.',
          )
        }
        return {
          id: existing.id,
          orderNumber: existing.orderNumber,
          totalAmount: existing.totalAmount,
          itemCount: existing.items.length,
        }
      }
    }

    const branch = await orderRepository.findActiveBranch(client, input.branchId)
    if (!branch) throw new AppError(404, 'BRANCH_NOT_FOUND', 'Choose an active branch.')

    const customer = await orderRepository.findActiveCustomer(
      client,
      input.customerId,
      context.customerBranchScope,
    )
    if (!customer) throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Choose an active customer.')

    const products = new Map<string, { unitPrice: string }>()
    const lockOrder = [...input.items].sort((left, right) =>
      left.productId.localeCompare(right.productId),
    )
    for (const item of lockOrder) {
      const product = await orderRepository.findActiveProduct(client, item.productId)
      if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Choose an active product.')

      const stock = await orderRepository.findStockForUpdate(client, item.productId, input.branchId)
      if (
        !stock ||
        quantityToMilli(stock.quantity) - quantityToMilli(stock.reservedQuantity) <
          quantityToMilli(item.quantity)
      ) {
        throw new AppError(
          409,
          'INSUFFICIENT_STOCK',
          'There is not enough stock at this branch for every order item.',
          { productId: item.productId },
        )
      }
      products.set(item.productId, { unitPrice: product.unit_price })
    }

    const pricedItems = input.items.map((item) => {
      const product = products.get(item.productId)
      if (!product) throw new Error('A validated order product could not be found.')
      return {
        ...item,
        unitPrice: product.unitPrice,
        lineTotal: calculateLineTotal(product.unitPrice, item.quantity),
      }
    })
    if (!isOrderAmountRepresentable(pricedItems.map((item) => item.lineTotal))) {
      throw new AppError(
        400,
        'ORDER_TOTAL_TOO_LARGE',
        'The order total exceeds the supported amount.',
      )
    }
    const total = calculateOrderTotal(pricedItems.map((item) => item.lineTotal))
    const orderNumber = createOrderNumber()
    const orderId = await orderRepository.insertOrder(client, {
      orderNumber,
      customerId: input.customerId,
      branchId: input.branchId,
      total,
      createdBy: context.userId,
      requestKey: input.requestKey ?? null,
    })
    if (!orderId) throw new Error('The order could not be created.')

    for (const item of pricedItems) {
      const orderItemId = await orderRepository.insertOrderItem(client, {
        orderId,
        productId: item.productId,
        quantity: formatQuantityMilli(quantityToMilli(item.quantity)),
        unitPrice: item.unitPrice,
        lineTotal: item.lineTotal,
      })
      if (!orderItemId) throw new Error('An order item could not be saved.')
      const quantity = formatQuantityMilli(quantityToMilli(item.quantity))
      const reserved = await orderRepository.reserveInventory(
        client,
        item.productId,
        input.branchId,
        quantity,
      )
      if (!reserved) {
        throw new AppError(
          409,
          'INSUFFICIENT_STOCK',
          'Stock changed while placing the order. Review the items and try again.',
          { productId: item.productId },
        )
      }
      const reservationId = await orderLifecycleRepository.insertOrderReservation(client, {
        orderItemId,
        quantity,
        createdBy: context.userId,
      })
      if (!reservationId) throw new Error('A stock reservation could not be saved.')
      await orderRepository.insertReservationTransaction(client, {
        productId: item.productId,
        branchId: input.branchId,
        quantity,
        orderId,
        performedBy: context.userId,
      })
    }
    await orderRepository.insertOrderAuditLog(client, {
      userId: context.userId,
      branchId: input.branchId,
      orderId,
      orderNumber,
      customerId: input.customerId,
      items: pricedItems.map(({ productId, quantity, unitPrice, lineTotal }) => ({
        productId,
        quantity,
        unitPrice,
        lineTotal,
      })),
      total,
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })

    return { id: orderId, orderNumber, totalAmount: total, itemCount: pricedItems.length }
  })
}

function createOrderNumber() {
  return `ORD-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`
}
