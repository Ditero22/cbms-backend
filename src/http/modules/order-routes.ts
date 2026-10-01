import { Router } from 'express'
import { placeOrder, getOrderFormOptions, getOrderDetail } from '@/features/orders/order.service.js'
import {
  cancelOrder,
  completeOrder,
  getOrderLifecycleEligibility,
} from '@/features/orders/order-lifecycle.service.js'
import { cancelOrderSchema } from '@/features/orders/order-lifecycle.schemas.js'
import { AppError } from '@/shared/errors/AppError.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import { orderSchema } from '@/features/records/record-schemas.js'
import { z } from 'zod'

export const orderRouter = Router()

orderRouter.get('/orders/options', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('orders.create')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to create orders.')
  }

  const options = await getOrderFormOptions(getAssignedBranchScope(user))
  res.json(options)
})

orderRouter.get('/orders/:orderId', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  const parsedId = z.uuid().safeParse(req.params.orderId)
  if (!parsedId.success) throw new AppError(400, 'INVALID_ORDER_ID', 'The order ID is invalid.')
  res.json(await getOrderDetail(parsedId.data, user))
})

orderRouter.get('/orders/:orderId/lifecycle-eligibility', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  const parsedId = z.uuid().safeParse(req.params.orderId)
  if (!parsedId.success) throw new AppError(400, 'INVALID_ORDER_ID', 'The order ID is invalid.')
  res.json(await getOrderLifecycleEligibility(parsedId.data, user))
})

orderRouter.post('/orders/:orderId/complete', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('orders.complete')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to complete orders.')
  }
  const parsedId = z.uuid().safeParse(req.params.orderId)
  if (!parsedId.success) throw new AppError(400, 'INVALID_ORDER_ID', 'The order ID is invalid.')
  res.json(
    await completeOrder(parsedId.data, {
      user,
      ipAddress: req.ip ?? null,
      requestId: req.requestId ?? null,
    }),
  )
})

orderRouter.post('/orders/:orderId/cancel', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('orders.cancel')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to cancel orders.')
  }
  const parsedId = z.uuid().safeParse(req.params.orderId)
  if (!parsedId.success) throw new AppError(400, 'INVALID_ORDER_ID', 'The order ID is invalid.')
  const parsed = cancelOrderSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Check the cancellation details.',
      parsed.error.flatten(),
    )
  }
  res.json(
    await cancelOrder(parsedId.data, parsed.data, {
      user,
      ipAddress: req.ip ?? null,
      requestId: req.requestId ?? null,
    }),
  )
})

orderRouter.post('/orders', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('orders.create')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to create orders.')
  }

  const parsed = orderSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the order details.', parsed.error.flatten())
  }

  if (!user.isCrossBranch && user.branchId !== parsed.data.branchId) {
    throw new AppError(
      403,
      'BRANCH_FORBIDDEN',
      'You can only create orders for your assigned branch.',
    )
  }

  const order = await placeOrder(parsed.data, {
    userId: user.id,
    customerBranchScope: user.isCrossBranch ? null : user.branchId,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })

  res.status(201).json(order)
})
