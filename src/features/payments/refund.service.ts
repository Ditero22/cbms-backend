import { randomUUID } from 'node:crypto'
import { withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import { formatMoneyCents, moneyToCents } from '@/shared/domain/fixed-point.js'
import * as orderLifecycleRepository from '@/features/orders/order-lifecycle.repository.js'
import * as refundRepository from './refund.repository.js'

type RefundContext = {
  user: AuthenticatedUser
  ipAddress: string | null
  requestId: string | null
}

export async function listOrderRefunds(orderId: string, user: AuthenticatedUser) {
  requirePermission(user, 'sales.read')
  return withTransaction(async (client) => {
    const order = await lockOrderInScope(client, orderId, user)
    return refundRepository.listOrderRefundsWithClient(client, order.id)
  })
}

export async function requestRefund(
  orderId: string,
  input: {
    requestKey: string
    paymentId: string
    amount: string
    method: string
    reason: string
    notes?: string | undefined
  },
  context: RefundContext,
) {
  requirePermission(context.user, 'payments.refund.request')
  return withTransaction(async (client) => {
    const order = await lockOrderInScope(client, orderId, context.user)
    const existing = await refundRepository.findRefundByRequestKey(client, input.requestKey)
    if (existing) {
      if (
        existing.orderId !== order.id ||
        existing.paymentId !== input.paymentId ||
        moneyToCents(existing.amount) !== moneyToCents(input.amount) ||
        existing.method !== input.method ||
        existing.reason !== input.reason ||
        existing.notes !== (input.notes ?? null)
      ) {
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'This refund request key was already used for different details.',
        )
      }
      return existing
    }

    const payment = await refundRepository.findPaymentForUpdate(client, order.id, input.paymentId)
    if (!payment || payment.status !== 'Paid') {
      throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Choose a recorded payment on this order.')
    }
    const totals = await refundRepository.getRefundTotalsForPayment(client, payment.id)
    const remaining =
      moneyToCents(payment.amount) - moneyToCents(totals.processed) - moneyToCents(totals.pending)
    const amount = moneyToCents(input.amount)
    if (amount > remaining) {
      throw new AppError(
        409,
        'REFUND_EXCEEDS_PAYMENT',
        'Refund amount exceeds the payment amount still available.',
        {
          available: formatMoneyCents(remaining),
        },
      )
    }

    const reference = `REF-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`
    const refundId = await refundRepository.insertRefund(client, {
      reference,
      requestKey: input.requestKey,
      orderId: order.id,
      paymentId: payment.id,
      amount: formatMoneyCents(amount),
      method: input.method,
      reason: input.reason,
      notes: input.notes ?? null,
      requestedBy: context.user.id,
    })
    if (!refundId) throw new Error('The refund request could not be saved.')
    await refundRepository.insertRefundAudit(client, {
      userId: context.user.id,
      branchId: order.branchId,
      refundId,
      action: 'requested payment refund',
      payload: {
        reference,
        orderId: order.id,
        paymentId: payment.id,
        amount: formatMoneyCents(amount),
        method: input.method,
        reason: input.reason,
      },
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })
    return {
      id: refundId,
      reference,
      orderId: order.id,
      paymentId: payment.id,
      amount: formatMoneyCents(amount),
      status: 'Requested',
    }
  })
}

export async function approveRefund(refundId: string, context: RefundContext) {
  requirePermission(context.user, 'payments.refund.approve')
  return transitionRefund(refundId, context, 'Requested', 'Approved')
}

export async function rejectRefund(refundId: string, reason: string, context: RefundContext) {
  requirePermission(context.user, 'payments.refund.approve')
  return transitionRefund(refundId, context, 'Requested', 'Rejected', reason)
}

export async function processRefund(
  refundId: string,
  reference: string | undefined,
  context: RefundContext,
) {
  requirePermission(context.user, 'payments.refund.process')
  return withTransaction(async (client) => {
    const orderId = await refundRepository.findRefundOrderId(client, refundId)
    if (!orderId) throw new AppError(404, 'REFUND_NOT_FOUND', 'The refund request was not found.')
    const order = await lockOrderInScope(client, orderId, context.user)
    const refund = await refundRepository.findRefundForUpdate(client, refundId)
    if (!refund) throw new AppError(404, 'REFUND_NOT_FOUND', 'The refund request was not found.')
    if (refund.status !== 'Approved') {
      throw new AppError(409, 'REFUND_NOT_APPROVED', 'Only an approved refund can be processed.')
    }
    const totals = await refundRepository.getRefundTotalsForPayment(client, refund.paymentId)
    const payment = await refundRepository.findPaymentForUpdate(client, order.id, refund.paymentId)
    if (
      !payment ||
      moneyToCents(totals.processed) + moneyToCents(refund.amount) > moneyToCents(payment.amount)
    ) {
      throw new AppError(
        409,
        'REFUND_EXCEEDS_PAYMENT',
        'The refund can no longer be safely processed.',
      )
    }
    const processed = await refundRepository.transitionRefund(client, {
      refundId,
      from: 'Approved',
      to: 'Processed',
      userId: context.user.id,
      ...(reference === undefined ? {} : { reference }),
    })
    if (!processed)
      throw new AppError(
        409,
        'REFUND_STATE_CHANGED',
        'The refund status changed. Refresh and try again.',
      )
    await refundRepository.insertRefundAudit(client, {
      userId: context.user.id,
      branchId: order.branchId,
      refundId,
      action: 'processed payment refund',
      payload: {
        reference: refund.reference,
        amount: refund.amount,
        paymentId: refund.paymentId,
        processedReference: reference ?? null,
      },
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })
    return {
      id: refund.id,
      reference: refund.reference,
      status: 'Processed',
      amount: refund.amount,
    }
  })
}

async function transitionRefund(
  refundId: string,
  context: RefundContext,
  from: string,
  to: 'Approved' | 'Rejected',
  reason?: string,
) {
  return withTransaction(async (client) => {
    const orderId = await refundRepository.findRefundOrderId(client, refundId)
    if (!orderId) throw new AppError(404, 'REFUND_NOT_FOUND', 'The refund request was not found.')
    const order = await lockOrderInScope(client, orderId, context.user)
    const refund = await refundRepository.findRefundForUpdate(client, refundId)
    if (!refund) throw new AppError(404, 'REFUND_NOT_FOUND', 'The refund request was not found.')
    if (refund.status !== from)
      throw new AppError(
        409,
        'REFUND_STATE_CHANGED',
        `Only a ${from.toLowerCase()} refund can be ${to.toLowerCase()}.`,
      )
    const changed = await refundRepository.transitionRefund(client, {
      refundId,
      from,
      to,
      userId: context.user.id,
      ...(reason === undefined ? {} : { reason }),
    })
    if (!changed)
      throw new AppError(
        409,
        'REFUND_STATE_CHANGED',
        'The refund status changed. Refresh and try again.',
      )
    await refundRepository.insertRefundAudit(client, {
      userId: context.user.id,
      branchId: order.branchId,
      refundId,
      action: to === 'Approved' ? 'approved payment refund' : 'rejected payment refund',
      payload: { reference: refund.reference, amount: refund.amount, reason: reason ?? null },
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })
    return { id: refund.id, reference: refund.reference, status: to, amount: refund.amount }
  })
}

async function lockOrderInScope(
  client: Parameters<typeof orderLifecycleRepository.lockOrder>[0],
  orderId: string,
  user: AuthenticatedUser,
) {
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
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to manage payment refunds.')
  }
}
