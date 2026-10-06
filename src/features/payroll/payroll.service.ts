import {
  readPayrollRun,
  readPayrollEntries,
  readPayrollAdjustments,
} from './payroll-read.repository.js'
import { writeAudit } from './payroll-audit.js'
export { markPayrollEntryPaid, markPayrollEntryPaidWithProof } from './payroll-payment.service.js'
import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '@/database/client.js'
import { withTransaction } from '@/database/transaction.js'
import { getProofContent } from '@/features/attachments/attachment.service.js'
import {
  formatMoneyCents,
  formatQuantityMilli,
  moneyToCents,
  quantityToMilli,
} from '@/shared/domain/fixed-point.js'
import { AppError } from '@/shared/errors/AppError.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import { philippineDate } from '@/shared/philippine-date.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import type {
  ConfirmPayrollReceiptInput,
  CreatePayrollRunInput,
  UpdatePayrollRunInput,
} from './payroll.schemas.js'

export type PayrollContext = {
  user: AuthenticatedUser
  ipAddress: string | null
  requestId: string | null
}

const maxMoneyCents = 99_999_999_999_999n
const entryPageSize = 25

type AdjustmentInput = CreatePayrollRunInput['entries'][number]['adjustments'][number]
type PayrollEntryInput = CreatePayrollRunInput['entries'][number]

type EmployeeSnapshot = {
  id: string
  employeeNumber: string
  name: string
  position: string
}

type EntryTotals = {
  regularPay: string
  additionalPay: string
  deductions: string
  grossPay: string
  netPay: string
}

function requirePermission(user: AuthenticatedUser, permission: string) {
  if (!user.permissions.includes(permission)) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to manage payroll.')
  }
}

function assertBranchAccess(user: AuthenticatedUser, branchId: string) {
  if (!user.isCrossBranch && user.branchId !== branchId) {
    throw new AppError(
      403,
      'BRANCH_FORBIDDEN',
      'You can only manage payroll for your assigned branch.',
    )
  }
}

function calculateEntryTotals(entry: PayrollEntryInput): EntryTotals {
  const regularPayCents = (moneyToCents(entry.rate) * quantityToMilli(entry.units) + 500n) / 1000n
  const earningCents = entry.adjustments
    .filter((adjustment) => adjustment.kind === 'earning')
    .reduce((total, adjustment) => total + moneyToCents(adjustment.amount), 0n)
  const deductionCents = entry.adjustments
    .filter((adjustment) => adjustment.kind === 'deduction')
    .reduce((total, adjustment) => total + moneyToCents(adjustment.amount), 0n)
  const grossCents = regularPayCents + earningCents
  const netCents = grossCents - deductionCents

  if (
    regularPayCents > maxMoneyCents ||
    earningCents > maxMoneyCents ||
    deductionCents > maxMoneyCents ||
    grossCents > maxMoneyCents ||
    netCents < 0n ||
    netCents > maxMoneyCents
  ) {
    throw new AppError(
      400,
      'INVALID_PAYROLL_TOTAL',
      'The pay, additions, and deductions must produce a non-negative total within the supported amount range.',
    )
  }

  return {
    regularPay: formatMoneyCents(regularPayCents),
    additionalPay: formatMoneyCents(earningCents),
    deductions: formatMoneyCents(deductionCents),
    grossPay: formatMoneyCents(grossCents),
    netPay: formatMoneyCents(netCents),
  }
}

function payrollIntentFingerprint(input: CreatePayrollRunInput) {
  const canonicalIntent = {
    branchId: input.branchId.toLowerCase(),
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    entries: input.entries
      .map((entry) => ({
        employeeId: entry.employeeId.toLowerCase(),
        payBasis: entry.payBasis,
        units: formatQuantityMilli(quantityToMilli(entry.units)),
        rate: formatMoneyCents(moneyToCents(entry.rate)),
        adjustments: entry.adjustments.map((adjustment) => ({
          kind: adjustment.kind,
          type: adjustment.type,
          amount: formatMoneyCents(moneyToCents(adjustment.amount)),
          notes: adjustment.notes.trim(),
        })),
      }))
      .sort((left, right) => left.employeeId.localeCompare(right.employeeId)),
  }
  return createHash('sha256').update(JSON.stringify(canonicalIntent)).digest('hex')
}

async function findPayrollCreateRequest(
  client: PoolClient,
  requestKey: string,
): Promise<
  | {
      id: string
      reference: string
      status: 'Draft' | 'Processed'
      userId: string
      fingerprint: string
    }
  | undefined
> {
  const result = await client.query<{
    id: string
    reference: string
    status: 'Draft' | 'Processed'
    userId: string
    fingerprint: string
  }>(
    `select id::text as id, reference, status,
            request_user_id::text as "userId", request_fingerprint as fingerprint
       from payroll_runs where request_key=$1`,
    [requestKey],
  )
  return result.rows[0]
}

function dateStart(value: string) {
  return `${value}T00:00:00.000Z`
}

async function validateBranch(client: PoolClient, branchId: string, user: AuthenticatedUser) {
  assertBranchAccess(user, branchId)
  const branch = await client.query(
    `select id from branches where id=$1 and status='Active' and deleted_at is null for share`,
    [branchId],
  )
  if (!branch.rowCount) throw new AppError(400, 'INVALID_BRANCH', 'Choose an active branch.')
}

export async function getPayrollOptions(user: AuthenticatedUser, requestedBranchId?: string) {
  requirePermission(user, 'payroll.create')
  const branchScope = getAssignedBranchScope(user)
  if (requestedBranchId) assertBranchAccess(user, requestedBranchId)
  const selectedBranchId = requestedBranchId ?? branchScope ?? undefined
  const branches = await pool.query<{ id: string; name: string }>(
    `select id, name from branches
     where status='Active' and deleted_at is null
       and ($1::uuid is null or id=$1::uuid)
       and ($2::uuid is null or id=$2::uuid)
     order by name, id`,
    [selectedBranchId ?? null, branchScope],
  )
  const validBranch = selectedBranchId
    ? branches.rows.find((branch) => branch.id === selectedBranchId)
    : undefined
  if (selectedBranchId && !validBranch) {
    throw new AppError(400, 'INVALID_BRANCH', 'Choose an active branch you can access.')
  }
  const employees = validBranch
    ? await pool.query<EmployeeSnapshot>(
        `select id, employee_number as "employeeNumber", name, position
         from employees
         where branch_id=$1 and status='Active' and deleted_at is null
         order by name, employee_number, id`,
        [validBranch.id],
      )
    : { rows: [] as EmployeeSnapshot[] }
  return {
    branches: branches.rows,
    selectedBranchId: validBranch?.id ?? null,
    employees: employees.rows,
  }
}

async function loadEmployees(
  client: PoolClient,
  branchId: string,
  entries: PayrollEntryInput[],
): Promise<Map<string, EmployeeSnapshot>> {
  const requestedIds = entries.map((entry) => entry.employeeId)
  if (new Set(requestedIds).size !== requestedIds.length) {
    throw new AppError(
      400,
      'DUPLICATE_PAYROLL_EMPLOYEE',
      'An employee can only appear once in a pay run.',
    )
  }
  const result = await client.query<EmployeeSnapshot>(
    `select id, employee_number as "employeeNumber", name, position
     from employees
     where id=any($1::uuid[]) and branch_id=$2 and status='Active' and deleted_at is null
     order by id for share`,
    [requestedIds, branchId],
  )
  if (result.rows.length !== entries.length) {
    throw new AppError(
      400,
      'INVALID_PAYROLL_EMPLOYEE',
      'Choose active employees from the selected branch. Refresh the employee list and try again.',
    )
  }
  return new Map(result.rows.map((employee) => [employee.id, employee]))
}

async function insertEntries(
  client: PoolClient,
  runId: string,
  branchId: string,
  entries: PayrollEntryInput[],
  employees: Map<string, EmployeeSnapshot>,
) {
  let totalGrossCents = 0n
  for (const entry of entries) {
    const employee = employees.get(entry.employeeId)
    if (!employee) {
      throw new AppError(
        400,
        'INVALID_PAYROLL_EMPLOYEE',
        'Choose an active employee in this branch.',
      )
    }
    const totals = calculateEntryTotals(entry)
    totalGrossCents += moneyToCents(totals.grossPay)
    if (totalGrossCents > maxMoneyCents) {
      throw new AppError(
        400,
        'INVALID_PAYROLL_TOTAL',
        'The gross pay total exceeds the supported amount range.',
      )
    }
    const saved = await client.query<{ id: string }>(
      `insert into payroll_entries
         (payroll_run_id, employee_id, branch_id, employee_number, employee_name, position,
          pay_basis, units, rate, regular_pay, additional_pay, deductions, gross_pay, net_pay)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       returning id`,
      [
        runId,
        employee.id,
        branchId,
        employee.employeeNumber,
        employee.name,
        employee.position,
        entry.payBasis,
        entry.units,
        entry.rate,
        totals.regularPay,
        totals.additionalPay,
        totals.deductions,
        totals.grossPay,
        totals.netPay,
      ],
    )
    const entryId = saved.rows[0]?.id
    if (!entryId)
      throw new AppError(500, 'PAYROLL_ENTRY_FAILED', 'A payroll entry could not be saved.')
    for (const adjustment of entry.adjustments) {
      await insertAdjustment(client, entryId, adjustment)
    }
  }
  return { employeeCount: entries.length, grossPay: formatMoneyCents(totalGrossCents) }
}

async function insertAdjustment(client: PoolClient, entryId: string, adjustment: AdjustmentInput) {
  await client.query(
    `insert into payroll_entry_adjustments(payroll_entry_id,kind,type,amount,notes,created_at)
     values($1,$2,$3,$4,$5,clock_timestamp())`,
    [entryId, adjustment.kind, adjustment.type, adjustment.amount, adjustment.notes || null],
  )
}

export async function createPayrollRun(input: CreatePayrollRunInput, context: PayrollContext) {
  requirePermission(context.user, 'payroll.create')
  assertBranchAccess(context.user, input.branchId)
  return withTransaction(async (client) => {
    const requestKey = input.requestKey?.toLowerCase()
    const fingerprint = requestKey ? payrollIntentFingerprint(input) : null
    if (requestKey && fingerprint) {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `payroll-create:${requestKey}`,
      ])
      const existing = await findPayrollCreateRequest(client, requestKey)
      if (existing) {
        if (existing.userId !== context.user.id || existing.fingerprint !== fingerprint) {
          throw new AppError(
            409,
            'REQUEST_KEY_CONFLICT',
            'This payroll request key was already used with different values.',
          )
        }
        return { id: existing.id, reference: existing.reference, status: existing.status }
      }
    }
    await validateBranch(client, input.branchId, context.user)
    const employees = await loadEmployees(client, input.branchId, input.entries)
    const reference = `PAY-${input.periodStart.slice(0, 4)}-${randomUUID().slice(0, 8).toUpperCase()}`
    const run = await client.query<{ id: string }>(
      `insert into payroll_runs
         (reference,period_start,period_end,branch_id,status,processed_by,processed_at,
          request_key,request_user_id,request_fingerprint)
       values($1,$2,$3,$4,'Draft',null,null,$5,$6,$7) returning id`,
      [
        reference,
        dateStart(input.periodStart),
        dateStart(input.periodEnd),
        input.branchId,
        requestKey ?? null,
        requestKey ? context.user.id : null,
        fingerprint,
      ],
    )
    const runId = run.rows[0]?.id
    if (!runId) throw new AppError(500, 'PAYROLL_CREATE_FAILED', 'The pay run could not be saved.')
    const totals = await insertEntries(client, runId, input.branchId, input.entries, employees)
    await client.query(`update payroll_runs set employee_count=$2,gross_pay=$3 where id=$1`, [
      runId,
      totals.employeeCount,
      totals.grossPay,
    ])
    await writeAudit(
      client,
      context,
      'payroll-run',
      runId,
      input.branchId,
      'created payroll run',
      null,
      {
        reference,
        branchId: input.branchId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        ...totals,
      },
    )
    return { id: runId, reference, status: 'Draft' as const }
  })
}

export async function updatePayrollRun(
  runId: string,
  input: UpdatePayrollRunInput,
  context: PayrollContext,
) {
  requirePermission(context.user, 'payroll.update')
  assertBranchAccess(context.user, input.branchId)
  return withTransaction(async (client) => {
    const current = await client.query<{
      id: string
      reference: string
      branchId: string
      status: string
      periodStart: Date
      periodEnd: Date
      grossPay: string
      employeeCount: number
    }>(
      `select id, reference, branch_id as "branchId", status,
              period_start as "periodStart", period_end as "periodEnd",
              gross_pay::text as "grossPay", employee_count as "employeeCount"
       from payroll_runs where id=$1 for update`,
      [runId],
    )
    const run = current.rows[0]
    if (!run || (getAssignedBranchScope(context.user) && run.branchId !== context.user.branchId)) {
      throw new AppError(404, 'PAYROLL_RUN_NOT_FOUND', 'Pay run not found.')
    }
    if (run.status !== 'Draft') {
      throw new AppError(409, 'PAYROLL_RUN_LOCKED', 'Processed pay runs cannot be edited.')
    }
    await validateBranch(client, input.branchId, context.user)
    const employees = await loadEmployees(client, input.branchId, input.entries)
    await client.query('delete from payroll_entries where payroll_run_id=$1', [runId])
    const totals = await insertEntries(client, runId, input.branchId, input.entries, employees)
    await client.query(
      `update payroll_runs
       set period_start=$2,period_end=$3,branch_id=$4,employee_count=$5,gross_pay=$6
       where id=$1`,
      [
        runId,
        dateStart(input.periodStart),
        dateStart(input.periodEnd),
        input.branchId,
        totals.employeeCount,
        totals.grossPay,
      ],
    )
    await writeAudit(
      client,
      context,
      'payroll-run',
      runId,
      input.branchId,
      'updated draft payroll run',
      run,
      { ...input, ...totals },
    )
    return { id: runId, reference: run.reference, status: 'Draft' as const }
  })
}

export async function processPayrollRun(runId: string, context: PayrollContext) {
  requirePermission(context.user, 'payroll.process')
  return withTransaction(async (client) => {
    const result = await client.query<{
      id: string
      branchId: string
      status: string
      reference: string
      grossPay: string
      employeeCount: number
    }>(
      `select id, branch_id as "branchId", status, reference,
              gross_pay::text as "grossPay", employee_count as "employeeCount"
       from payroll_runs where id=$1 for update`,
      [runId],
    )
    const run = result.rows[0]
    if (!run || (getAssignedBranchScope(context.user) && run.branchId !== context.user.branchId)) {
      throw new AppError(404, 'PAYROLL_RUN_NOT_FOUND', 'Pay run not found.')
    }
    if (run.status !== 'Draft') {
      throw new AppError(409, 'PAYROLL_RUN_LOCKED', 'Only Draft pay runs can be processed.')
    }
    const totals = await client.query<{ employeeCount: number; grossPay: string }>(
      `select count(*)::int as "employeeCount", coalesce(sum(gross_pay),0)::text as "grossPay"
       from payroll_entries where payroll_run_id=$1`,
      [runId],
    )
    if (!totals.rows[0]?.employeeCount) {
      throw new AppError(
        409,
        'PAYROLL_RUN_EMPTY',
        'Add at least one employee before processing this pay run.',
      )
    }
    const processedAt = new Date()
    await client.query(
      `update payroll_runs set status='Processed',employee_count=$2,gross_pay=$3,processed_by=$4,processed_at=$5 where id=$1`,
      [runId, totals.rows[0].employeeCount, totals.rows[0].grossPay, context.user.id, processedAt],
    )
    await writeAudit(
      client,
      context,
      'payroll-run',
      runId,
      run.branchId,
      'processed payroll run',
      { status: run.status, grossPay: run.grossPay, employeeCount: run.employeeCount },
      { status: 'Processed', ...totals.rows[0], processedBy: context.user.id, processedAt },
    )
    return { id: runId, status: 'Processed' as const, ...totals.rows[0] }
  })
}

export async function confirmPayrollEntryReceived(
  entryId: string,
  input: ConfirmPayrollReceiptInput,
  context: PayrollContext,
) {
  requirePermission(context.user, 'payroll.receive')
  return withTransaction(async (client) => {
    const result = await client.query<{
      id: string
      runId: string
      branchId: string
      runStatus: string
      paymentStatus: string
      paymentDate: string
    }>(
      `select e.id,e.payroll_run_id as "runId",e.branch_id as "branchId",
              r.status as "runStatus",e.payment_status as "paymentStatus",e.payment_date::text as "paymentDate"
       from payroll_entries e join payroll_runs r on r.id=e.payroll_run_id
       where e.id=$1 for update of e,r`,
      [entryId],
    )
    const entry = result.rows[0]
    if (
      !entry ||
      (getAssignedBranchScope(context.user) && entry.branchId !== context.user.branchId)
    ) {
      throw new AppError(404, 'PAYROLL_ENTRY_NOT_FOUND', 'Payroll entry not found.')
    }
    if (entry.runStatus !== 'Processed' || entry.paymentStatus !== 'Paid') {
      throw new AppError(
        409,
        'PAYROLL_RECEIPT_LOCKED',
        'Only paid payroll entries can be confirmed as received.',
      )
    }
    const receivedAt = new Date(input.receivedAt)
    if (
      philippineDate(receivedAt) < entry.paymentDate ||
      receivedAt.getTime() > Date.now() + 60_000
    ) {
      throw new AppError(
        400,
        'INVALID_RECEIVED_DATE',
        'Receipt date must be on or after payment and cannot be in the future.',
      )
    }
    let proof = false
    if (input.proofAttachmentId) {
      const attachment = await client.query(
        `select id from attachments where id=$1 and entity_type='payroll-entry' and entity_id=$2`,
        [input.proofAttachmentId, entryId],
      )
      proof = attachment.rowCount === 1
      if (!proof)
        throw new AppError(400, 'INVALID_PROOF', 'Choose a proof uploaded to this payroll entry.')
      await getProofContent(input.proofAttachmentId, context.user, client)
    }
    if (!proof && !input.acknowledgement.trim()) {
      throw new AppError(
        400,
        'RECEIPT_CONFIRMATION_REQUIRED',
        'Add the employee’s acknowledgement or an uploaded proof of receipt.',
      )
    }
    await client.query(
      `update payroll_entries set payment_status='Received',received_at=$2,confirmed_by=$3,
              acknowledgement=$4,updated_at=now() where id=$1`,
      [entryId, receivedAt, context.user.id, input.acknowledgement || null],
    )
    await writeAudit(
      client,
      context,
      'payroll-entry',
      entryId,
      entry.branchId,
      'confirmed payroll payment received',
      { paymentStatus: 'Paid' },
      {
        paymentStatus: 'Received',
        receivedAt,
        confirmedBy: context.user.id,
        acknowledgement: input.acknowledgement || null,
        proofAttachmentId: input.proofAttachmentId ?? null,
      },
    )
    return { id: entryId, status: 'Received' as const }
  })
}

export async function getPayrollRunDetail(
  runId: string,
  user: AuthenticatedUser,
  page = 1,
  limit = entryPageSize,
) {
  requirePermission(user, 'payroll.read')
  const branchScope = getAssignedBranchScope(user)
  return withTransaction(async (client) => {
    await client.query('set transaction isolation level repeatable read read only')
    const run = await readPayrollRun(client, runId, branchScope)
    if (!run) throw new AppError(404, 'PAYROLL_RUN_NOT_FOUND', 'Pay run not found.')
    const entries = await readPayrollEntries(client, runId, branchScope, page, limit)
    const adjustments = await readPayrollAdjustments(
      client,
      entries.map((entry) => entry.id),
    )
    const grouped = new Map<string, unknown[]>()
    for (const adjustment of adjustments) {
      const group = grouped.get(adjustment.payrollEntryId) ?? []
      group.push(adjustment)
      grouped.set(adjustment.payrollEntryId, group)
    }
    const totalEntries = Number(entries[0]?.totalEntries ?? 0)
    return {
      run,
      entries: entries.map((entry) => ({
        ...entry,
        adjustments: grouped.get(entry.id) ?? [],
      })),
      page,
      pageSize: limit,
      totalEntries,
      totalPages: Math.max(1, Math.ceil(totalEntries / limit)),
    }
  })
}
