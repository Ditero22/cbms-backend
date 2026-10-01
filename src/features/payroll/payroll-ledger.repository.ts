import { pool } from '@/database/client.js'
import { AppError } from '@/shared/errors/AppError.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import type { PayrollLedgerQuery } from './payroll.schemas.js'

const columns = `e.id,e.employee_id as "employeeId",e.employee_number as "employeeNumber",e.employee_name as "employeeName",e.position,
 e.branch_id as "branchId",b.name as "branchName",e.payroll_run_id as "runId",r.reference as "runReference",r.status as "runStatus",
 r.period_start::date::text as "periodStart",r.period_end::date::text as "periodEnd",e.pay_basis as "payBasis",e.units::text as units,e.rate::text as rate,
 e.regular_pay::text as "regularPay",e.additional_pay::text as "additionalPay",e.deductions::text as deductions,e.gross_pay::text as "grossPay",e.net_pay::text as "netPay",
 e.payment_status as "paymentStatus",e.payment_date::text as "paymentDate",e.payment_method as "paymentMethod",e.payment_reference as "paymentReference",e.payment_notes as "paymentNotes",
 e.paid_by as "paidBy",paid.name as "paidByName",e.paid_at as "paidAt",e.received_at as "receivedAt",e.confirmed_by as "confirmedBy",confirmed.name as "confirmedByName",e.acknowledgement,
 e.payment_proof_attachment_id as "proofAttachmentId",coalesce((select sum(a.amount) from payroll_entry_adjustments a where a.payroll_entry_id=e.id and a.kind='earning' and a.type='Allowance'),0)::text as "allowancePay"`
const joins = `from payroll_entries e join payroll_runs r on r.id=e.payroll_run_id join branches b on b.id=e.branch_id left join users paid on paid.id=e.paid_by left join users confirmed on confirmed.id=e.confirmed_by`

function scope(user: AuthenticatedUser, requestedBranchId?: string) {
  if (!user.permissions.includes('payroll.read'))
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view payroll.')
  const assigned = getAssignedBranchScope(user)
  if (assigned && requestedBranchId && assigned !== requestedBranchId)
    throw new AppError(403, 'BRANCH_FORBIDDEN', 'Choose your assigned branch.')
  return assigned ?? requestedBranchId ?? null
}

async function withAdjustments(rows: Record<string, unknown>[]) {
  if (!rows.length) return []
  const adjustments = await pool.query<{ payrollEntryId: string }>(
    `select id,payroll_entry_id as "payrollEntryId",kind,type,amount::text as amount,notes from payroll_entry_adjustments where payroll_entry_id=any($1::uuid[]) order by created_at,id`,
    [rows.map((row) => row.id)],
  )
  return rows.map((entry) => ({
    ...entry,
    adjustments: adjustments.rows.filter((adjustment) => adjustment.payrollEntryId === entry.id),
  }))
}

export async function getPayrollLedger(query: PayrollLedgerQuery, user: AuthenticatedUser) {
  const branchId = scope(user, query.branchId)
  const parameters = [
    branchId,
    query.search ? `%${query.search}%` : null,
    query.paymentStatus || null,
    query.periodStart ?? null,
    query.periodEnd ?? null,
  ]
  const where = `where ($1::uuid is null or e.branch_id=$1) and ($2::text is null or e.employee_name ilike $2 or e.employee_number ilike $2 or r.reference ilike $2) and ($3::text is null or e.payment_status=$3) and ($4::date is null or r.period_end::date >= $4) and ($5::date is null or r.period_start::date <= $5)`
  const sort = {
    employee: 'e.employee_name',
    period: 'r.period_start',
    netPay: 'e.net_pay',
    paymentStatus: 'e.payment_status',
  }[query.sort]
  const [entries, count, branches] = await Promise.all([
    pool.query(
      `select ${columns} ${joins} ${where} order by ${sort} ${query.order === 'desc' ? 'desc' : 'asc'},e.id limit $6 offset $7`,
      [...parameters, query.limit, (query.page - 1) * query.limit],
    ),
    pool.query<{ total: number }>(`select count(*)::int as total ${joins} ${where}`, parameters),
    pool.query<{ id: string; name: string }>(
      'select id,name from branches where ($1::uuid is null or id=$1) order by name,id',
      [getAssignedBranchScope(user) ?? null],
    ),
  ])
  const total = count.rows[0]?.total ?? 0
  return {
    items: await withAdjustments(entries.rows),
    total,
    page: query.page,
    pageSize: query.limit,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
    branches: branches.rows,
  }
}

export async function getPayrollEntryDetail(entryId: string, user: AuthenticatedUser) {
  const branchId = scope(user)
  const result = await pool.query(
    `select ${columns} ${joins} where e.id=$1 and ($2::uuid is null or e.branch_id=$2)`,
    [entryId, branchId],
  )
  if (!result.rows[0])
    throw new AppError(404, 'PAYROLL_ENTRY_NOT_FOUND', 'Payroll entry not found.')
  return { entry: (await withAdjustments(result.rows))[0] }
}
