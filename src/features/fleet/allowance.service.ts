import { pool } from '@/database/client.js'
import { withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import * as repository from './fleet.repository.js'
import type { FleetContext } from './fleet.repository.js'
import type { PoolClient } from 'pg'
import { getProofContent } from '@/features/attachments/attachment.service.js'

async function validateAllowance(
  client: PoolClient,
  input: Record<string, unknown>,
  context: FleetContext,
) {
  await repository.validateBranch(client, String(input.branchId), context.user)
  const employee = await client.query(
    `select id from employees where id=$1 and branch_id=$2 and deleted_at is null and status='Active' and is_driver=1`,
    [input.workerId, input.branchId],
  )
  if (!employee.rowCount)
    throw new AppError(400, 'INVALID_DRIVER', 'Choose an active driver from this branch.')
  if (input.assignmentId) {
    const assignment = await repository.fetchRecord(
      'vehicle_assignments',
      String(input.assignmentId),
      client,
    )
    if (
      !assignment ||
      assignment.driverId !== input.workerId ||
      assignment.branchId !== input.branchId ||
      (input.deliveryId && assignment.deliveryId !== input.deliveryId)
    )
      throw new AppError(
        400,
        'INVALID_ASSIGNMENT',
        'Choose an assignment belonging to this driver, branch and delivery.',
      )
  }
  if (input.deliveryId) {
    const delivery = await client.query(
      `select o.branch_id from deliveries d join orders o on o.id=d.order_id where d.id=$1`,
      [input.deliveryId],
    )
    if (delivery.rows[0]?.branch_id !== input.branchId)
      throw new AppError(400, 'INVALID_DELIVERY', 'Choose a delivery from this branch.')
    const driver = await client.query(
      `select driver_id from vehicle_assignments where delivery_id=$1 order by created_at desc limit 1`,
      [input.deliveryId],
    )
    if (driver.rows[0] && driver.rows[0].driver_id !== input.workerId)
      throw new AppError(
        400,
        'INVALID_DELIVERY_DRIVER',
        'This delivery is assigned to another worker.',
      )
  }
}
export async function getAllowanceDetail(id: string, user: AuthenticatedUser, historyPage = 1) {
  repository.requirePermission(user, 'driver-allowances.read')
  const allowance = repository.scopeRecord(
    await repository.fetchRecord('driver_allowances', id),
    user,
  )
  const names = await pool.query(
    `select e.name as "workerName",a.name as "authorizedByName",r.name as "releasedByName",c.name as "confirmedByName" from employees e left join users a on a.id=$2 left join users r on r.id=$3 left join users c on c.id=$4 where e.id=$1`,
    [allowance.workerId, allowance.authorizedBy, allowance.releasedBy, allowance.confirmedBy],
  )
  return {
    allowance: { ...allowance, ...names.rows[0] },
    ...(await repository.historyResponse('driver-allowance', id, user, historyPage)),
  }
}
export async function createAllowance(
  _input: Record<string, unknown>,
  _context: FleetContext,
): Promise<never> {
  void _input
  void _context
  throw new AppError(
    410,
    'LEGACY_ALLOWANCE_RETIRED',
    'New allowances are recorded as payroll adjustments. Existing driver allowance records remain available for historical review and settlement.',
  )
}
export async function updateAllowance(
  id: string,
  input: Record<string, unknown>,
  context: FleetContext,
) {
  repository.requirePermission(context.user, 'driver-allowances.update')
  return withTransaction(async (client) => {
    const current = repository.scopeRecord(
      await repository.fetchRecord('driver_allowances', id, client, true),
      context.user,
    )
    if (current.status !== 'Pending')
      throw new AppError(409, 'ALLOWANCE_LOCKED', 'Only Pending allowances can be edited.')
    const next = { ...current, ...input }
    await validateAllowance(client, next, context)
    await repository.updateRecord(client, 'driver_allowances', id, input)
    await repository.audit(
      client,
      context,
      'driver-allowance',
      id,
      String(next.branchId),
      'updated driver allowance',
      current,
      next,
    )
    return { id }
  })
}
export async function transitionAllowance(
  id: string,
  action: 'approve' | 'release' | 'receive' | 'cancel',
  input: {
    receivedAt?: string | undefined
    acknowledgement?: string | null | undefined
    proofAttachmentId?: string | undefined
  },
  context: FleetContext,
) {
  repository.requirePermission(context.user, `driver-allowances.${action}`)
  return withTransaction(async (client) => {
    const current = repository.scopeRecord(
      await repository.fetchRecord('driver_allowances', id, client, true),
      context.user,
    )
    const allowed =
      action === 'approve'
        ? current.status === 'Pending'
        : action === 'release'
          ? current.status === 'Approved'
          : action === 'receive'
            ? current.status === 'Released'
            : ['Pending', 'Approved'].includes(current.status)
    if (!allowed)
      throw new AppError(
        409,
        'INVALID_ALLOWANCE_TRANSITION',
        'This allowance is not eligible for that action. Released payments cannot be cancelled or silently changed.',
      )
    const fields: Record<string, unknown> = {
      status:
        action === 'approve'
          ? 'Approved'
          : action === 'release'
            ? 'Released'
            : action === 'receive'
              ? 'Received'
              : 'Cancelled',
    }
    if (action === 'approve') {
      fields.authorizedBy = context.user.id
      fields.authorizedAt = new Date()
    }
    if (action === 'release') {
      if (!current.authorizedBy || !current.authorizedAt)
        throw new AppError(
          409,
          'ALLOWANCE_NOT_AUTHORIZED',
          'Approval information is required before release.',
        )
      fields.expenseId = await repository.postExpense(
        client,
        context,
        current.branchId!,
        `Driver allowance ${current.reference}`,
        'Driver allowances',
        String(current.amount),
        { by: String(current.authorizedBy), at: current.authorizedAt },
      )
      fields.releasedBy = context.user.id
      fields.releasedAt = new Date()
    }
    if (action === 'receive') {
      if (!input.receivedAt)
        throw new AppError(
          400,
          'RECEIVED_DATE_REQUIRED',
          'Record when the worker received the money.',
        )
      const received = new Date(input.receivedAt)
      if (
        received.getTime() < new Date(String(current.releasedAt)).getTime() ||
        received.getTime() > Date.now() + 60000
      )
        throw new AppError(
          400,
          'INVALID_RECEIVED_DATE',
          'Receipt date must be after release and cannot be in the future.',
        )
      let proof = false
      if (input.proofAttachmentId) {
        const attachment = await client.query(
          `select id from attachments where id=$1 and entity_type='driver-allowance' and entity_id=$2`,
          [input.proofAttachmentId, id],
        )
        proof = attachment.rowCount === 1
        if (!proof)
          throw new AppError(400, 'INVALID_PROOF', 'Choose a proof uploaded to this allowance.')
        await getProofContent(input.proofAttachmentId, context.user, client)
      }
      if (!proof && !input.acknowledgement?.trim())
        throw new AppError(
          400,
          'RECEIPT_CONFIRMATION_REQUIRED',
          'Add the worker’s acknowledgement or an uploaded proof of receipt.',
        )
      fields.receivedAt = received
      fields.confirmedBy = context.user.id
      fields.acknowledgement = input.acknowledgement ?? null
    }
    await repository.updateRecord(client, 'driver_allowances', id, fields)
    await repository.audit(
      client,
      context,
      'driver-allowance',
      id,
      current.branchId!,
      `${action} driver allowance`,
      current,
      {
        ...current,
        ...fields,
        ...(input.proofAttachmentId ? { proofAttachmentId: input.proofAttachmentId } : {}),
      },
    )
    return { id, status: fields.status }
  })
}
