import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  cleanupProofAfterFailure,
  insertProofInTransaction,
  type ProofContext,
} from '@/features/attachments/attachment.service.js'
import { createProofKey } from '@/features/attachments/attachment.storage.js'
import type { ValidatedProof } from '@/features/attachments/proof-input.js'
import { withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import { formatMoneyCents, moneyToCents } from '@/shared/domain/fixed-point.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import type { RecordPaymentInput } from './payment.schemas.js'
import { philippineDate } from '@/shared/philippine-date.js'
import * as paymentRepository from './payment.repository.js'
import * as balanceRepository from './payment-balances.repository.js'

type PaymentRequestContext = {
  userId: string
  branchId: string | null
  isCrossBranch: boolean
  ipAddress: string | null
  requestId: string | null
}

export function getPaymentFormOptions(
  context: Pick<PaymentRequestContext, 'branchId' | 'isCrossBranch'>,
) {
  return paymentRepository.getPaymentOptions(getAssignedBranchScope(context))
}

export async function recordPayment(
  input: Omit<RecordPaymentInput, 'method'> & { method: string },
  context: PaymentRequestContext,
) {
  return withTransaction((client) => recordPaymentInTransaction(client, input, context))
}

export async function recordPaymentWithProof(
  input: RecordPaymentInput,
  proof: ValidatedProof,
  context: ProofContext,
) {
  if (
    !context.user.permissions.includes('payments.create') ||
    !context.user.permissions.includes('payments.read')
  )
    throw new AppError(
      403,
      'FORBIDDEN',
      'You do not have permission to record customer payments with proof.',
    )
  if (!input.requestKey || !input.paymentDate)
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Provide a payment request key and actual payment date.',
    )
  const requestKey = input.requestKey.toLowerCase()
  let objectKey: string | undefined
  try {
    return await withTransaction((client) =>
      recordPaymentInTransaction(
        client,
        { ...input, requestKey },
        {
          userId: context.user.id,
          branchId: context.user.branchId,
          isCrossBranch: context.user.isCrossBranch,
          ipAddress: context.ipAddress,
          requestId: context.requestId,
        },
        { proof, context, allocateKey: () => (objectKey = createProofKey()) },
      ),
    )
  } catch (error) {
    await cleanupProofAfterFailure(objectKey, error)
    throw error
  }
}

async function recordPaymentInTransaction(
  client: PoolClient,
  input: Omit<RecordPaymentInput, 'method'> & { method: string },
  context: PaymentRequestContext,
  upload?: { proof: ValidatedProof; context: ProofContext; allocateKey: () => string },
) {
  const requestFingerprint = upload
    ? createHash('sha256')
        .update(
          JSON.stringify({
            orderId: input.orderId.toLowerCase(),
            amount: formatMoneyCents(moneyToCents(input.amount)),
            method: input.method,
            paymentDate: input.paymentDate,
            externalReference: input.externalReference?.trim() || null,
            notes: input.notes?.trim() || null,
            proof: {
              hash: upload.proof.hash,
              fileName: upload.proof.fileName,
              mimeType: upload.proof.mimeType,
            },
          }),
        )
        .digest('hex')
    : null
  if (input.requestKey) await paymentRepository.lockPaymentRequestKey(client, input.requestKey)
  const order = await paymentRepository.findOrderForUpdate(client, input.orderId)
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Choose an existing order.')
  if (!context.isCrossBranch && (!context.branchId || context.branchId !== order.branchId)) {
    throw new AppError(403, 'BRANCH_FORBIDDEN', 'You can only record payments for your branch.')
  }
  const paidAmount = await paymentRepository.getPaidAmount(client, order.id)
  const refundTotals = await paymentRepository.getRefundTotals(client, order.id)
  const balanceCents =
    moneyToCents(order.payableAmount) -
    moneyToCents(paidAmount) +
    moneyToCents(refundTotals.processed)
  const externalReference = input.externalReference?.trim() || null
  const notes = input.notes?.trim() || null
  if (input.requestKey) {
    const existing = await paymentRepository.findPaymentByRequestKey(client, input.requestKey)
    if (existing) {
      if (
        existing.orderId !== order.id ||
        existing.recordedBy !== context.userId ||
        moneyToCents(existing.amount) !== moneyToCents(input.amount) ||
        existing.method !== input.method ||
        (input.paymentDate !== undefined && existing.paymentDate !== input.paymentDate) ||
        existing.externalReference !== externalReference ||
        existing.notes !== notes ||
        (upload && existing.requestFingerprint !== requestFingerprint)
      ) {
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'This payment request key was already used for different details.',
        )
      }
      return {
        id: existing.id,
        reference: existing.reference,
        orderId: order.id,
        amount: existing.amount,
        remainingBalance: formatMoneyCents(balanceCents),
        proofAttachmentId: existing.proofAttachmentId,
      }
    }
  }
  if (order.status === 'Cancelled' || order.status === 'Completed') {
    throw new AppError(409, 'ORDER_CLOSED', 'Payments cannot be recorded for a closed order.')
  }
  if (moneyToCents(refundTotals.pending) > 0n) {
    throw new AppError(
      409,
      'REFUND_PENDING',
      'Resolve the pending refund before recording another payment.',
    )
  }
  const amountCents = moneyToCents(input.amount)
  if (amountCents <= 0n)
    throw new AppError(400, 'INVALID_PAYMENT_AMOUNT', 'Payment amount must be greater than zero.')
  if (balanceCents <= 0n) {
    throw new AppError(409, 'ORDER_PAID', 'This order has no remaining balance.')
  }
  if (amountCents > balanceCents) {
    throw new AppError(
      409,
      'PAYMENT_EXCEEDS_BALANCE',
      'Payment cannot exceed the remaining balance.',
      {
        balance: formatMoneyCents(balanceCents),
      },
    )
  }

  const reference = createPaymentReference()
  const paymentDate = input.paymentDate ?? philippineDate()
  const paymentId = await paymentRepository.insertPayment(client, {
    reference,
    orderId: order.id,
    method: input.method,
    amount: input.amount,
    recordedBy: context.userId,
    paymentDate,
    externalReference,
    notes,
    requestKey: input.requestKey ?? null,
    requestFingerprint,
  })
  if (!paymentId) throw new Error('The payment could not be recorded.')

  const remainingBalance = balanceCents - amountCents
  await paymentRepository.insertPaymentAuditLog(client, {
    userId: context.userId,
    branchId: order.branchId,
    paymentId,
    paymentReference: reference,
    orderId: order.id,
    amount: input.amount,
    method: input.method,
    paymentDate,
    externalReference,
    notes,
    ipAddress: context.ipAddress,
    requestId: context.requestId,
  })

  let proofAttachmentId: string | null = null
  if (upload) {
    const attachment = await insertProofInTransaction(
      client,
      { entityType: 'payment', entityId: paymentId },
      upload.proof,
      upload.context,
      upload.allocateKey(),
    )
    proofAttachmentId = attachment.id
    await client.query('update payments set payment_proof_attachment_id=$2 where id=$1', [
      paymentId,
      proofAttachmentId,
    ])
  }
  return {
    id: paymentId,
    reference,
    orderId: order.id,
    amount: input.amount,
    remainingBalance: formatMoneyCents(remainingBalance),
    proofAttachmentId,
  }
}

export async function getCustomerPaymentDetail(orderId: string, user: AuthenticatedUser) {
  if (!user.permissions.includes('payments.read')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view customer payments.')
  }
  const branchScope = getAssignedBranchScope(user)
  return withTransaction(async (client) => {
    // Balance and receipt history must describe the same committed financial state.
    await client.query('set transaction isolation level repeatable read read only')
    const order = await balanceRepository.getCustomerPaymentOrder(orderId, branchScope, client)
    if (!order)
      throw new AppError(404, 'PAYMENT_ORDER_NOT_FOUND', 'This customer transaction was not found.')
    const payments = await balanceRepository.getCustomerPaymentHistory(order.id, client)
    const refunds = await balanceRepository.getCustomerRefundHistory(order.id, client)
    const history = user.permissions.includes('audit.read')
      ? await balanceRepository.getCustomerPaymentAudit(order.id, order.branchId, client)
      : []
    const recordingBlocker = !user.permissions.includes('payments.create')
      ? 'You do not have permission to record customer payments.'
      : ['Completed', 'Cancelled'].includes(order.orderStatus)
        ? 'This order is closed.'
        : moneyToCents(order.pendingRefundAmount) > 0n
          ? 'Resolve the pending refund before recording another payment.'
          : moneyToCents(order.balance) <= 0n
            ? 'This transaction has no remaining collectible balance.'
            : null
    return {
      ...order,
      payments,
      refunds,
      history,
      canRecordPayment: recordingBlocker === null,
      recordingBlocker,
    }
  })
}

function createPaymentReference() {
  return `PAY-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`
}
