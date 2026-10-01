import type { PoolClient } from 'pg'

export const expenseHistoryPageSize = 20
export type ExpenseRecord = {
  id: string
  description: string
  category: string
  branchId: string
  branchName: string
  branchStatus: string
  amount: string
  status: string
  submittedBy: string
  submittedByName: string
  createdAt: Date
  updatedAt: Date
  approvedBy: string | null
  approvedByName: string | null
  approvedAt: Date | null
}
export type ExpenseReview = {
  decision: 'Approved' | 'Rejected'
  note: string | null
  reviewerId: string | null
  reviewerName: string | null
  reviewedAt: Date | null
}

export async function findExpenseDetail(client: PoolClient, id: string, branchScope?: string) {
  const result = await client.query<ExpenseRecord>(
    `select e.id::text as id,e.description,e.category,e.branch_id::text as "branchId",b.name as "branchName",
            case when b.deleted_at is not null then 'Archived' else b.status end as "branchStatus",
            e.amount::text as amount,e.status,e.submitted_by::text as "submittedBy",submitter.name as "submittedByName",
            e.created_at as "createdAt",e.updated_at as "updatedAt",e.approved_by::text as "approvedBy",
            approver.name as "approvedByName",e.approved_at as "approvedAt"
     from expenses e join branches b on b.id=e.branch_id join users submitter on submitter.id=e.submitted_by
     left join users approver on approver.id=e.approved_by where e.id=$1 ${branchScope ? 'and e.branch_id=$2' : ''}`,
    branchScope ? [id, branchScope] : [id],
  )
  return result.rows[0]
}

export async function findExpenseReview(
  client: PoolClient,
  expense: ExpenseRecord,
): Promise<ExpenseReview | null> {
  if (expense.status !== 'Approved' && expense.status !== 'Rejected') return null
  const result = await client.query<ExpenseReview>(
    `select a.new_value->>'status' as decision,a.new_value->>'reviewNote' as note,
            a.user_id::text as "reviewerId",u.name as "reviewerName",a.created_at as "reviewedAt"
     from audit_logs a left join users u on u.id=a.user_id
     where a.entity_type='expenses' and a.entity_id=$1 and a.branch_id=$2
       and ((a.action='expense approved' and $3='Approved') or (a.action='expense rejected' and $3='Rejected'))
       and a.new_value->>'status'=$3
     order by a.created_at desc,a.id desc limit 1`,
    [expense.id, expense.branchId, expense.status],
  )
  if (result.rows[0]) return result.rows[0]
  // Allowance release creates an already approved expense, without a manual
  // expense-review event. Its existing approval fields remain authoritative.
  if (expense.status === 'Approved')
    return {
      decision: 'Approved',
      note: null,
      reviewerId: expense.approvedBy,
      reviewerName: expense.approvedByName,
      reviewedAt: expense.approvedAt,
    }
  return null
}

export async function findExpenseSource(
  client: PoolClient,
  expense: ExpenseRecord,
  permissions: readonly string[],
) {
  const result = await client.query<{
    entityType: 'vehicle-maintenance' | 'driver-allowance'
    id: string
    reference: string
    status: string
    vehicleName: string | null
    plateNumber: string | null
    workerName: string | null
    paymentType: string | null
    method: string | null
  }>(
    `select 'vehicle-maintenance' as "entityType",m.id::text as id,m.reference,m.status,
            v.name as "vehicleName",v.plate_number as "plateNumber",null::text as "workerName",
            null::text as "paymentType",null::text as method
     from vehicle_maintenance m join vehicles v on v.id=m.vehicle_id where m.expense_id=$1 and m.branch_id=$2
     union all
     select 'driver-allowance' as "entityType",a.id::text as id,a.reference,a.status,
            null::text as "vehicleName",null::text as "plateNumber",e.name as "workerName",a.payment_type as "paymentType",a.method
     from driver_allowances a join employees e on e.id=a.worker_id where a.expense_id=$1 and a.branch_id=$2`,
    [expense.id, expense.branchId],
  )
  // There is no cross-table source invariant in the existing schema. Ambiguous
  // legacy links do not justify choosing an arbitrary origin or inventing one.
  if (result.rows.length !== 1) return null
  const source = result.rows[0]!
  if (source.entityType === 'vehicle-maintenance') {
    if (!permissions.includes('vehicles.maintenance')) return null
    return {
      entityType: source.entityType,
      id: source.id,
      reference: source.reference,
      title: `Maintenance ${source.reference}`,
      status: source.status,
      vehicleName: source.vehicleName,
      plateNumber: source.plateNumber,
    }
  }
  if (!permissions.includes('driver-allowances.read')) return null
  return {
    entityType: source.entityType,
    id: source.id,
    reference: source.reference,
    title: `Allowance ${source.reference}`,
    status: source.status,
    workerName: source.workerName,
    paymentType: source.paymentType,
    method: source.method,
  }
}

export async function getExpenseHistory(client: PoolClient, expense: ExpenseRecord, page: number) {
  const parameters = [expense.id, expense.branchId]
  const condition = "a.entity_type='expenses' and a.entity_id=$1 and a.branch_id=$2"
  const count = await client.query<{ total: string }>(
    `select count(*)::text as total from audit_logs a where ${condition}`,
    parameters,
  )
  const result = await client.query(
    `select a.id::text as id,a.action,a.old_value as "oldValue",a.new_value as "newValue",
            u.name as "actorName",a.created_at as "createdAt"
     from audit_logs a left join users u on u.id=a.user_id where ${condition}
     order by a.created_at desc,a.id desc limit $3 offset $4`,
    [...parameters, expenseHistoryPageSize, (page - 1) * expenseHistoryPageSize],
  )
  return { history: result.rows, historyTotal: Number(count.rows[0]?.total ?? 0) }
}
