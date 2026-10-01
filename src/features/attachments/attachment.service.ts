import type { PoolClient } from 'pg'
import { pool } from '@/database/client.js'
import { TransactionCommitError, withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import { logger } from '@/config/logger.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { hasProofSignature, maxProofBytes, type ProofEntity } from './attachment.schemas.js'
import { createProofKey, readProof, removeStoredProof, saveProof } from './attachment.storage.js'
import { validateProofInput, type ValidatedProof } from './proof-input.js'

type QueryClient = Pick<PoolClient, 'query'>
export type ProofContext = {
  user: AuthenticatedUser
  ipAddress: string | null
  requestId: string | null
}

export async function authorizeProof(
  entity: ProofEntity,
  user: AuthenticatedUser,
  upload = false,
  client: QueryClient = pool,
  lock = false,
) {
  const permissions =
    entity.entityType === 'payment'
      ? ['payments.read']
      : entity.entityType === 'vehicle-maintenance'
        ? ['vehicles.maintenance', 'expenses.read']
        : entity.entityType === 'driver-allowance'
          ? ['driver-allowances.read']
          : ['payroll.read']
  if (!permissions.every((key) => user.permissions.includes(key)))
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view this proof.')
  if (upload && entity.entityType === 'payment' && !user.permissions.includes('payments.create'))
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to attach payment proof.')
  if (
    upload &&
    entity.entityType === 'driver-allowance' &&
    !['driver-allowances.release', 'driver-allowances.receive'].some((key) =>
      user.permissions.includes(key),
    )
  )
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to attach receiving proof.')
  if (
    upload &&
    entity.entityType === 'payroll-entry' &&
    !['payroll.pay', 'payroll.receive'].some((key) => user.permissions.includes(key))
  )
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to attach payroll proof.')
  const branchScope = getAssignedBranchScope(user)
  const query =
    entity.entityType === 'payment'
      ? `select o.branch_id as "branchId", p.status from payments p join orders o on o.id=p.order_id where p.id=$1 ${lock ? 'for update of p' : ''}`
      : entity.entityType === 'vehicle-maintenance'
        ? `select branch_id as "branchId", status from vehicle_maintenance where id=$1 ${lock ? 'for update' : ''}`
        : entity.entityType === 'driver-allowance'
          ? `select branch_id as "branchId", status from driver_allowances where id=$1 ${lock ? 'for update' : ''}`
          : `select e.branch_id as "branchId", e.payment_status as status from payroll_entries e join payroll_runs r on r.id=e.payroll_run_id where e.id=$1 and r.status='Processed' ${lock ? 'for update of e, r' : ''}`
  const parent = (
    await client.query<{ branchId: string; status: string }>(query, [entity.entityId])
  ).rows[0]
  if (!parent || (branchScope && parent.branchId !== branchScope))
    throw new AppError(404, 'PROOF_PARENT_NOT_FOUND', 'The related record was not found.')
  if (
    upload &&
    entity.entityType === 'driver-allowance' &&
    !['Released', 'Received'].includes(parent.status)
  )
    throw new AppError(
      409,
      'ALLOWANCE_NOT_RELEASED',
      'Release the allowance before adding receiving proof.',
    )
  if (upload && entity.entityType === 'vehicle-maintenance' && parent.status === 'Cancelled')
    throw new AppError(
      409,
      'MAINTENANCE_CANCELLED',
      'Cancelled maintenance cannot receive new proof.',
    )
  if (
    upload &&
    entity.entityType === 'payroll-entry' &&
    !['Paid', 'Received'].includes(parent.status)
  )
    throw new AppError(
      409,
      'PAYROLL_NOT_PAID',
      'Record the payroll payment before attaching payment or receipt proof.',
    )
  return parent
}

const metadataColumns =
  'a.id, a.file_name as "fileName", a.mime_type as "mimeType", a.file_size as "fileSize", u.name as "uploadedByName", a.created_at as "createdAt"'

export async function listProofs(entity: ProofEntity, user: AuthenticatedUser) {
  await authorizeProof(entity, user)
  const result = await pool.query(
    `select ${metadataColumns} from attachments a join users u on u.id=a.uploaded_by where a.entity_type=$1 and a.entity_id=$2 order by a.created_at desc, a.id desc limit 50`,
    [entity.entityType, entity.entityId],
  )
  return { items: result.rows }
}

export async function uploadProof(
  entity: ProofEntity,
  fileName: string,
  mimeType: string,
  bytes: unknown,
  context: ProofContext,
) {
  const proof = validateProofInput(fileName, mimeType, bytes)
  const objectKey = createProofKey()
  try {
    return await withTransaction((client) =>
      insertProofInTransaction(client, entity, proof, context, objectKey),
    )
  } catch (error) {
    await cleanupProofAfterFailure(objectKey, error)
    throw error
  }
}

export async function cleanupProofAfterFailure(objectKey: string | undefined, error: unknown) {
  // A failed COMMIT may have succeeded remotely. Retain its object for replay/reconciliation.
  if (objectKey && !(error instanceof TransactionCommitError))
    await removeStoredProof(objectKey).catch(() => {
      logger.warn(
        { errorCode: 'PROOF_CLEANUP_FAILED' },
        'A private proof object needs reconciliation',
      )
    })
}

export async function insertProofInTransaction(
  client: PoolClient,
  entity: ProofEntity,
  proof: ValidatedProof,
  context: ProofContext,
  objectKey: string,
) {
  const { fileName, mimeType, bytes } = proof
  const parent = await authorizeProof(entity, context.user, true, client, true)
  const count = await client.query<{ count: number }>(
    'select count(*)::int as count from attachments where entity_type=$1 and entity_id=$2',
    [entity.entityType, entity.entityId],
  )
  if ((count.rows[0]?.count ?? 0) >= 50)
    throw new AppError(409, 'PROOF_LIMIT_REACHED', 'This record already has 50 proof files.')
  await saveProof(bytes, mimeType, objectKey)
  const result = await client.query<{ id: string }>(
    `insert into attachments(file_name,object_key,mime_type,file_size,uploaded_by,entity_type,entity_id) values($1,$2,$3,$4,$5,$6,$7) returning id`,
    [
      fileName,
      objectKey,
      mimeType,
      bytes.length,
      context.user.id,
      entity.entityType,
      entity.entityId,
    ],
  )
  const id = result.rows[0]!.id
  await client.query(
    `insert into audit_logs(user_id,branch_id,action,entity_type,entity_id,new_value,ip_address,request_id) values($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [
      context.user.id,
      parent.branchId,
      'uploaded proof',
      entity.entityType,
      entity.entityId,
      JSON.stringify({ attachmentId: id, fileName, mimeType, fileSize: bytes.length }),
      context.ipAddress,
      context.requestId,
    ],
  )
  return { id }
}

export async function getProofContent(
  id: string,
  user: AuthenticatedUser,
  client: QueryClient = pool,
) {
  const result = await client.query<{
    fileName: string
    mimeType: string
    fileSize: number
    objectKey: string
    entityType: ProofEntity['entityType']
    entityId: string
  }>(
    'select file_name as "fileName", mime_type as "mimeType", file_size as "fileSize", object_key as "objectKey", entity_type as "entityType", entity_id as "entityId" from attachments where id=$1',
    [id],
  )
  const attachment = result.rows[0]
  if (!attachment) throw new AppError(404, 'PROOF_NOT_FOUND', 'Proof not found.')
  if (
    !['payment', 'vehicle-maintenance', 'driver-allowance', 'payroll-entry'].includes(
      attachment.entityType,
    )
  )
    throw new AppError(404, 'PROOF_NOT_FOUND', 'Proof not found.')
  await authorizeProof(attachment, user, false, client)
  const bytes = await readProof(attachment.objectKey)
  if (
    bytes.length !== attachment.fileSize ||
    bytes.length > maxProofBytes ||
    !hasProofSignature(bytes, attachment.mimeType)
  )
    throw new AppError(503, 'PROOF_STORAGE_INVALID', 'The stored proof needs administrator review.')
  return { fileName: attachment.fileName, mimeType: attachment.mimeType, bytes }
}
