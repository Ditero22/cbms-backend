import { Router, type Request } from 'express'
import {
  approveRefund,
  listOrderRefunds,
  processRefund,
  rejectRefund,
  requestRefund,
} from '@/features/payments/refund.service.js'
import {
  processRefundSchema,
  rejectWorkflowSchema,
  requestRefundSchema,
} from '@/features/payments/refund.schemas.js'
import {
  approveReturn,
  listOrderReturns,
  receiveReturn,
  rejectReturn,
  requestReturn,
} from '@/features/orders/return.service.js'
import { receiveReturnSchema, requestReturnSchema } from '@/features/orders/return.schemas.js'
import { AppError } from '@/shared/errors/AppError.js'
import { z } from 'zod'

export const orderWorkflowRouter = Router()

orderWorkflowRouter.get('/orders/:orderId/refunds', async (req, res) => {
  const user = requireUser(req.user)
  res.json(await listOrderRefunds(parseId(req.params.orderId, 'order'), user))
})

orderWorkflowRouter.post('/orders/:orderId/refunds', async (req, res) => {
  const user = requirePermission(
    req.user,
    'payments.refund.request',
    'You do not have permission to request refunds.',
  )
  const parsed = requestRefundSchema.safeParse(req.body)
  if (!parsed.success)
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Check the refund request details.',
      parsed.error.flatten(),
    )
  const result = await requestRefund(
    parseId(req.params.orderId, 'order'),
    parsed.data,
    context(req, user),
  )
  res.status(201).json(result)
})

orderWorkflowRouter.patch('/refunds/:refundId/approve', async (req, res) => {
  const user = requirePermission(
    req.user,
    'payments.refund.approve',
    'You do not have permission to approve refunds.',
  )
  res.json(await approveRefund(parseId(req.params.refundId, 'refund'), context(req, user)))
})

orderWorkflowRouter.patch('/refunds/:refundId/reject', async (req, res) => {
  const user = requirePermission(
    req.user,
    'payments.refund.approve',
    'You do not have permission to reject refunds.',
  )
  const parsed = rejectWorkflowSchema.safeParse(req.body)
  if (!parsed.success)
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Provide a rejection reason.',
      parsed.error.flatten(),
    )
  res.json(
    await rejectRefund(
      parseId(req.params.refundId, 'refund'),
      parsed.data.reason,
      context(req, user),
    ),
  )
})

orderWorkflowRouter.patch('/refunds/:refundId/process', async (req, res) => {
  const user = requirePermission(
    req.user,
    'payments.refund.process',
    'You do not have permission to process refunds.',
  )
  const parsed = processRefundSchema.safeParse(req.body)
  if (!parsed.success)
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Check the refund processing details.',
      parsed.error.flatten(),
    )
  res.json(
    await processRefund(
      parseId(req.params.refundId, 'refund'),
      parsed.data.reference,
      context(req, user),
    ),
  )
})

orderWorkflowRouter.get('/orders/:orderId/returns', async (req, res) => {
  const user = requireUser(req.user)
  res.json(await listOrderReturns(parseId(req.params.orderId, 'order'), user))
})

orderWorkflowRouter.post('/orders/:orderId/returns', async (req, res) => {
  const user = requirePermission(
    req.user,
    'returns.create',
    'You do not have permission to request returns.',
  )
  const parsed = requestReturnSchema.safeParse(req.body)
  if (!parsed.success)
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Check the return request details.',
      parsed.error.flatten(),
    )
  const result = await requestReturn(
    parseId(req.params.orderId, 'order'),
    parsed.data,
    context(req, user),
  )
  res.status(201).json(result)
})

orderWorkflowRouter.patch('/returns/:returnId/approve', async (req, res) => {
  const user = requirePermission(
    req.user,
    'returns.approve',
    'You do not have permission to approve returns.',
  )
  res.json(await approveReturn(parseId(req.params.returnId, 'return'), context(req, user)))
})

orderWorkflowRouter.patch('/returns/:returnId/reject', async (req, res) => {
  const user = requirePermission(
    req.user,
    'returns.approve',
    'You do not have permission to reject returns.',
  )
  const parsed = rejectWorkflowSchema.safeParse(req.body)
  if (!parsed.success)
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Provide a rejection reason.',
      parsed.error.flatten(),
    )
  res.json(
    await rejectReturn(
      parseId(req.params.returnId, 'return'),
      parsed.data.reason,
      context(req, user),
    ),
  )
})

orderWorkflowRouter.patch('/returns/:returnId/receive', async (req, res) => {
  const user = requirePermission(
    req.user,
    'returns.receive',
    'You do not have permission to receive returns.',
  )
  const parsed = receiveReturnSchema.safeParse(req.body)
  if (!parsed.success)
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Classify every return item.',
      parsed.error.flatten(),
    )
  res.json(
    await receiveReturn(parseId(req.params.returnId, 'return'), parsed.data, context(req, user)),
  )
})

function requireUser(user: Request['user']) {
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  return user
}

function requirePermission(user: Request['user'], permission: string, message: string) {
  const authenticated = requireUser(user)
  if (!authenticated.permissions.includes(permission)) throw new AppError(403, 'FORBIDDEN', message)
  return authenticated
}

function parseId(value: string | undefined, label: string) {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success)
    throw new AppError(400, `INVALID_${label.toUpperCase()}_ID`, `The ${label} ID is invalid.`)
  return parsed.data
}

function context(req: Request, user: NonNullable<Request['user']>) {
  return { user, ipAddress: req.ip ?? null, requestId: req.requestId ?? null }
}
