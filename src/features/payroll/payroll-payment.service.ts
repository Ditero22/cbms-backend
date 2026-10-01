import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import {
  cleanupProofAfterFailure,
  insertProofInTransaction,
} from '@/features/attachments/attachment.service.js'
import { createProofKey } from '@/features/attachments/attachment.storage.js'
import type { ValidatedProof } from '@/features/attachments/proof-input.js'
import { philippineDate } from '@/shared/philippine-date.js'
import type { PayrollContext } from './payroll.service.js'
import type { MarkPayrollPaidInput } from './payroll.schemas.js'
import { writeAudit } from './payroll-audit.js'

export async function markPayrollEntryPaid(
  entryId: string,
  input: MarkPayrollPaidInput,
  context: PayrollContext,
) {
  return withTransaction((client) => payEntry(client, entryId, input, context))
}

export async function markPayrollEntryPaidWithProof(
  entryId: string,
  input: MarkPayrollPaidInput,
  proof: ValidatedProof,
  context: PayrollContext,
) {
  if (!input.requestKey)
    throw new AppError(400, 'VALIDATION_ERROR', 'Provide a payment request key.')
  let objectKey: string | undefined
  try {
    return await withTransaction((client) =>
      payEntry(client, entryId, input, context, {
        proof,
        allocateKey: () => (objectKey = createProofKey()),
      }),
    )
  } catch (error) {
    await cleanupProofAfterFailure(objectKey, error)
    throw error
  }
}

async function payEntry(
  client: PoolClient,
  entryId: string,
  input: MarkPayrollPaidInput,
  context: PayrollContext,
  upload?: { proof: ValidatedProof; allocateKey: () => string },
) {
  if (
    !context.user.permissions.includes('payroll.pay') ||
    (upload && !context.user.permissions.includes('payroll.read'))
  )
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to record payroll payments.')
  if (input.paymentDate > philippineDate())
    throw new AppError(400, 'INVALID_PAYMENT_DATE', 'Payment date cannot be in the future.')
  const fingerprint = upload
    ? createHash('sha256')
        .update(
          JSON.stringify({
            entryId: entryId.toLowerCase(),
            paymentDate: input.paymentDate,
            paymentMethod: input.paymentMethod,
            paymentReference: input.paymentReference || null,
            paymentNotes: input.paymentNotes || null,
            proof: {
              hash: upload.proof.hash,
              fileName: upload.proof.fileName,
              mimeType: upload.proof.mimeType,
            },
          }),
        )
        .digest('hex')
    : null
  if (upload && input.requestKey) {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `payroll-payment:${input.requestKey.toLowerCase()}`,
    ])
    const existing = (
      await client.query<{
        id: string
        branchId: string
        paidBy: string
        fingerprint: string
        proofAttachmentId: string
      }>(
        `select id,branch_id as "branchId",paid_by as "paidBy",payment_request_fingerprint as fingerprint,payment_proof_attachment_id as "proofAttachmentId" from payroll_entries where payment_request_key=$1`,
        [input.requestKey],
      )
    ).rows[0]
    if (existing) {
      if (
        existing.id !== entryId.toLowerCase() ||
        existing.paidBy !== context.user.id ||
        existing.fingerprint !== fingerprint ||
        (getAssignedBranchScope(context.user) && existing.branchId !== context.user.branchId)
      )
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'This payroll payment request key was already used for different details.',
        )
      return { id: entryId, status: 'Paid' as const, proofAttachmentId: existing.proofAttachmentId }
    }
  }
  const entry = (
    await client.query<{
      id: string
      branchId: string
      runStatus: string
      paymentStatus: string
      netPay: string
    }>(
      `select e.id,e.branch_id as "branchId",r.status as "runStatus",e.payment_status as "paymentStatus",e.net_pay::text as "netPay" from payroll_entries e join payroll_runs r on r.id=e.payroll_run_id where e.id=$1 for update of e,r`,
      [entryId],
    )
  ).rows[0]
  if (!entry || (getAssignedBranchScope(context.user) && entry.branchId !== context.user.branchId))
    throw new AppError(404, 'PAYROLL_ENTRY_NOT_FOUND', 'Payroll entry not found.')
  if (entry.runStatus !== 'Processed' || entry.paymentStatus !== 'Pending')
    throw new AppError(
      409,
      'PAYROLL_PAYMENT_LOCKED',
      'Only unpaid entries in a Processed pay run can be paid.',
    )
  const paidAt = new Date()
  await client.query(
    `update payroll_entries set payment_status='Paid',payment_date=$2,payment_method=$3,payment_reference=$4,paid_by=$5,paid_at=$6,payment_notes=$7,payment_request_key=$8,payment_request_fingerprint=$9,updated_at=now() where id=$1`,
    [
      entryId,
      input.paymentDate,
      input.paymentMethod,
      input.paymentReference || null,
      context.user.id,
      paidAt,
      input.paymentNotes || null,
      upload ? (input.requestKey ?? null) : null,
      fingerprint,
    ],
  )
  let proofAttachmentId: string | null = null
  if (upload) {
    const attachment = await insertProofInTransaction(
      client,
      { entityType: 'payroll-entry', entityId: entryId },
      upload.proof,
      context,
      upload.allocateKey(),
    )
    proofAttachmentId = attachment.id
    await client.query('update payroll_entries set payment_proof_attachment_id=$2 where id=$1', [
      entryId,
      proofAttachmentId,
    ])
  }
  await writeAudit(
    client,
    context,
    'payroll-entry',
    entryId,
    entry.branchId,
    'recorded payroll payment',
    { paymentStatus: 'Pending' },
    {
      paymentStatus: 'Paid',
      paymentDate: input.paymentDate,
      paymentMethod: input.paymentMethod,
      paymentReference: input.paymentReference || null,
      paymentNotes: input.paymentNotes || null,
      paidBy: context.user.id,
      paidAt,
      netPay: entry.netPay,
      proofAttachmentId,
    },
  )
  return { id: entryId, status: 'Paid' as const, proofAttachmentId }
}
