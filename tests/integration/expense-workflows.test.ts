import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '@/app.js'
import { pool } from '@/database/client.js'
import { permissionKeys } from '@/database/permissions.js'
import {
  createSessionToken,
  hashSessionToken,
  sessionCookieName,
} from '@/shared/security/session.js'
import type { ExpenseRecord, ExpenseReview } from '@/features/expenses/expense-detail.repository.js'

type ApiError = { error: { code: string; message: string } }
type Created = { id: string }
type Source = {
  entityType: 'vehicle-maintenance' | 'driver-allowance'
  id: string
  reference: string
  title: string
  status: string
  vehicleName?: string
  plateNumber?: string
  workerName?: string
  paymentType?: string
  method?: string
}
type Detail = {
  expense: ExpenseRecord
  review: ExpenseReview | null
  source: Source | null
  history: {
    id: string
    action: string
    actorName: string
    oldValue: unknown
    newValue: Record<string, unknown>
    createdAt: string
  }[]
  historyPage: number
  historyPageSize: number
  historyTotal: number
}
let server: Server,
  apiUrl: string,
  branchId: string,
  otherBranchId: string,
  inactiveBranchId: string,
  archivedBranchId: string,
  actorId: string,
  approverId: string,
  crossAdminId: string | undefined,
  vehicleId: string,
  workerId: string
const cookies: Record<string, string> = {}
const fixture = randomUUID().slice(0, 8)
let referenceSequence = 0
const insertId = async (sql: string, values: unknown[]) =>
  (await pool.query<{ id: string }>(sql, values)).rows[0]!.id

async function account(
  label: string,
  assignedBranch: string | null,
  permissions: string[],
  crossBranch = false,
) {
  const roleId = crossBranch
    ? await insertId(
        `insert into roles(name,is_system) values('Administrator',1)
         on conflict(name) do update set is_system=1 returning id`,
        [],
      )
    : await insertId('insert into roles(name, is_system) values($1, 0) returning id', [
        `Expense HTTP ${label} ${fixture}`,
      ])
  for (const permission of permissions)
    await pool.query(
      `insert into role_permissions(role_id,permission_key) values($1,$2)
       on conflict do nothing`,
      [roleId, permission],
    )
  const userId = await insertId(
    "insert into users(name,email,password_hash,role_id,branch_id,is_cross_branch) values($1,$2,'unused-test',$3,$4,$5) returning id",
    [
      `Expense ${label}`,
      `expense-${label}-${fixture}@example.invalid`,
      roleId,
      assignedBranch,
      crossBranch ? 1 : 0,
    ],
  )
  const token = createSessionToken()
  await pool.query(
    "insert into user_sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')",
    [userId, hashSessionToken(token)],
  )
  cookies[label] = `${sessionCookieName}=${token}`
  return userId
}
async function request<T>(
  method: string,
  path: string,
  label?: string,
  body?: Record<string, unknown>,
) {
  const response = await fetch(`${apiUrl}/api/v1${path}`, {
    method,
    headers: {
      ...(label ? { Cookie: cookies[label] ?? '' } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: (await response.json()) as T }
}
const payload = (
  description = 'Materials transport',
  amount: string | number = '125.25',
  category = 'Operations',
) => ({ description, category, amount })
const create = (body: Record<string, unknown> = payload(), label = 'operator') =>
  request<Created>('POST', '/expenses', label, body)
const detail = (id: string, label = 'operator', query = '') =>
  request<Detail>('GET', `/expenses/${id}${query}`, label)
const review = (id: string, decision = 'Approved', note?: string, label = 'operator') =>
  request<{ id: string; status: string }>('PATCH', `/expenses/${id}/review`, label, {
    decision,
    ...(note !== undefined ? { note } : {}),
  })

async function maintenance(expenseId: string, sourceBranch = branchId) {
  referenceSequence++
  const reference = `EX-M-${fixture}-${referenceSequence}`
  const id = await insertId(
    "insert into vehicle_maintenance(reference,vehicle_id,branch_id,maintenance_type,description,labor_cost,status,started_on,completed_on,expense_id,created_by) values($1,$2,$3,'General Repair','Recorded repair',125.25,'Completed','2026-09-29','2026-09-30',$4,$5) returning id",
    [reference, vehicleId, sourceBranch, expenseId, actorId],
  )
  return { id, reference }
}
async function allowance(expenseId: string, sourceBranch = branchId) {
  referenceSequence++
  const reference = `EX-A-${fixture}-${referenceSequence}`
  const id = await insertId(
    "insert into driver_allowances(reference,worker_id,branch_id,payment_type,amount,payment_timing,method,status,authorized_by,authorized_at,released_by,released_at,expense_id,created_by) values($1,$2,$3,'Trip allowance',125.25,'After trip','Cash','Released',$4,'2026-09-29T03:00:00Z',$5,'2026-09-30T03:00:00Z',$6,$5) returning id",
    [reference, workerId, sourceBranch, approverId, actorId, expenseId],
  )
  return { id, reference }
}

beforeAll(async () => {
  for (const key of permissionKeys)
    await pool.query(
      'insert into permissions(key,description) values($1,$2) on conflict do nothing',
      [key, `Expense HTTP ${key}`],
    )
  branchId = await insertId('insert into branches(name,code) values($1,$2) returning id', [
    `Expense North ${fixture}`,
    `en-${fixture}`,
  ])
  otherBranchId = await insertId('insert into branches(name,code) values($1,$2) returning id', [
    `Expense South ${fixture}`,
    `es-${fixture}`,
  ])
  inactiveBranchId = await insertId(
    "insert into branches(name,code,status) values($1,$2,'Inactive') returning id",
    [`Expense Inactive ${fixture}`, `ei-${fixture}`],
  )
  archivedBranchId = await insertId(
    'insert into branches(name,code,deleted_at) values($1,$2,now()) returning id',
    [`Expense Archived ${fixture}`, `ea-${fixture}`],
  )
  actorId = await account('operator', branchId, permissionKeys)
  approverId = await account('approver', branchId, ['expenses.approve'])
  await account('viewer', branchId, ['expenses.read'])
  await account('clerk', branchId, ['expenses.create'])
  await account('auditor', branchId, ['expenses.read', 'audit.read'])
  await account('maintenance-reader', branchId, ['expenses.read', 'vehicles.maintenance'])
  await account('allowance-reader', branchId, ['expenses.read', 'driver-allowances.read'])
  await account('outsider', otherBranchId, permissionKeys)
  await account('unassigned', null, permissionKeys)
  await account('unprivileged', branchId, [])
  crossAdminId = await account('cross', null, permissionKeys, true)
  vehicleId = await insertId(
    "insert into vehicles(name,plate_number,vehicle_type,branch_id) values($1,$2,'Truck',$3) returning id",
    [`Expense truck ${fixture}`, `EXP-${fixture}`, branchId],
  )
  workerId = await insertId(
    "insert into employees(employee_number,name,position,branch_id,is_driver) values($1,$2,'Truck Driver',$3,1) returning id",
    [`EXP-${fixture}`, `Expense worker ${fixture}`, branchId],
  )
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expense HTTP server did not start.')
  apiUrl = `http://127.0.0.1:${address.port}`
})
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  if (crossAdminId) {
    await pool.query("update users set status = 'Inactive' where id = $1", [crossAdminId])
  }
  await pool.end()
})

describe('authoritative expense access and manual submissions', () => {
  it('enforces authentication, domain grants and actual branch scope before detail or writes', async () => {
    const saved = await create()
    expect(saved.status).toBe(201)
    expect((await request('GET', `/expenses/${saved.body.id}`)).status).toBe(401)
    expect((await detail(saved.body.id, 'unprivileged')).status).toBe(403)
    expect((await detail(saved.body.id, 'outsider')).status).toBe(404)
    expect((await detail(saved.body.id, 'unassigned')).status).toBe(403)
    expect((await detail(saved.body.id, 'cross')).status).toBe(200)
    expect((await create(payload(), 'viewer')).status).toBe(403)
    expect((await create({ ...payload(), branchId: otherBranchId })).status).toBe(403)
    expect((await create({ ...payload(), branchId }, 'unassigned')).status).toBe(403)
    expect((await request('GET', '/expenses/options', 'unassigned')).status).toBe(403)
    expect((await request('GET', '/expenses', 'unassigned')).status).toBe(403)
    expect((await review(saved.body.id, 'Approved', undefined, 'viewer')).status).toBe(403)
    expect((await review(saved.body.id, 'Approved', undefined, 'outsider')).status).toBe(404)
    expect((await review(saved.body.id, 'Approved', undefined, 'unassigned')).status).toBe(403)
  })
  it('retains exact amounts and real submitter metadata without leaking full audit or internal retry keys', async () => {
    const requestKey = randomUUID()
    const saved = await create({
      ...payload('Recorded fuel', '10.25', 'Custom equipment supply'),
      requestKey,
    })
    const result = (await detail(saved.body.id, 'viewer')).body
    expect(result.expense).toMatchObject({
      id: saved.body.id,
      description: 'Recorded fuel',
      category: 'Custom equipment supply',
      branchId,
      amount: '10.25',
      status: 'Pending',
      submittedBy: actorId,
      submittedByName: 'Expense operator',
      approvedBy: null,
      approvedAt: null,
    })
    expect(result).toMatchObject({
      review: null,
      source: null,
      history: [],
      historyTotal: 0,
      historyPage: 1,
      historyPageSize: 20,
    })
    expect(result.expense).not.toHaveProperty('requestKey')
    const audited = (await detail(saved.body.id, 'auditor')).body
    expect(audited.history).toMatchObject([
      {
        action: 'created expenses',
        actorName: 'Expense operator',
        newValue: { amount: '10.25', submittedBy: actorId, status: 'Pending' },
      },
    ])
    expect(audited.history[0]!.newValue).not.toHaveProperty('requestKey')
  })
  it('rejects silent rounding, forged metadata and invalid identifiers or pages', async () => {
    for (const amount of ['1.001', '0', '-1', '1000000000000', '1e2', null, true])
      expect((await create({ ...payload(), amount })).status).toBe(400)
    for (const forged of [
      { submittedBy: approverId },
      { status: 'Approved' },
      { approvedBy: approverId },
      { source: 'manual' },
      { requestKey: 'arbitrary' },
    ])
      expect((await create({ ...payload(), ...forged })).status).toBe(400)
    expect((await detail('not-a-uuid')).status).toBe(400)
    const saved = await create()
    for (const query of [
      '?historyPage=0',
      '?historyPage=1.5',
      '?historyPage=100001',
      '?limit=1000',
    ])
      expect((await detail(saved.body.id, 'operator', query)).status).toBe(400)
    expect((await review(saved.body.id, 'Rejected', ' ')).status).toBe(400)
    expect((await review(saved.body.id, 'Unknown')).status).toBe(400)
  })
  it('checks active branch targets transactionally and permits explicitly scoped cross-branch submissions', async () => {
    for (const target of [inactiveBranchId, archivedBranchId, randomUUID()]) {
      const failed = await create(
        { ...payload(), branchId: target, requestKey: randomUUID() },
        'cross',
      )
      expect(failed.status).toBe(400)
    }
    expect((await create(payload(), 'cross')).status).toBe(400)
    const other = await create(
      { ...payload('South branch purchase'), branchId: otherBranchId },
      'cross',
    )
    expect(other.status).toBe(201)
    expect((await detail(other.body.id, 'operator')).status).toBe(404)
    expect((await detail(other.body.id, 'outsider')).body.expense.branchId).toBe(otherBranchId)
    const archived = await insertId(
      "insert into expenses(description,category,amount,branch_id,submitted_by) values('Historical archived charge','Archive',1,$1,$2) returning id",
      [archivedBranchId, actorId],
    )
    expect((await detail(archived, 'cross')).body.expense.branchStatus).toBe('Archived')
  })
  it('deduplicates concurrent manual retries including uppercase UUIDs while rejecting changed intent or actors', async () => {
    const requestKey = randomUUID()
    const lower = { ...payload('Counted purchase', '0.01', 'Office supplies'), requestKey }
    const results = await Promise.all([
      create(lower),
      create({
        ...lower,
        description: '  Counted purchase  ',
        amount: 0.01,
        requestKey: requestKey.toUpperCase(),
      }),
    ])
    expect(results.every((row) => row.status === 201)).toBe(true)
    expect(results[0]!.body.id).toBe(results[1]!.body.id)
    expect((await detail(results[0]!.body.id)).body.historyTotal).toBe(1)
    for (const changed of [
      { amount: '0.02' },
      { category: 'Different category' },
      { description: 'Different description' },
    ]) {
      const response = await request<ApiError>('POST', '/expenses', 'operator', {
        ...lower,
        ...changed,
      })
      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('REQUEST_KEY_CONFLICT')
    }
    expect((await create({ ...lower, branchId }, 'cross')).status).toBe(409)
    expect((await create(lower, 'viewer')).status).toBe(403)
    const row = await pool.query<{ total: string }>(
      'select count(*)::text as total from expenses where request_key=$1',
      [requestKey],
    )
    expect(row.rows[0]?.total).toBe('1')
    const recoveredKey = randomUUID()
    expect(
      (
        await create(
          { ...payload(), branchId: inactiveBranchId, requestKey: recoveredKey },
          'cross',
        )
      ).status,
    ).toBe(400)
    expect(
      (await create({ ...payload(), branchId, requestKey: recoveredKey }, 'cross')).status,
    ).toBe(201)
  })
  it('derives category suggestions from permitted expense rows and sorts raw amounts numerically up to the supported ceiling', async () => {
    const category = `Category ${fixture}`
    const search = `Expense sort ${fixture}`
    const small = await create(payload(`${search} small`, '2.25', category))
    const medium = await create(payload(`${search} medium`, '10.25', category))
    const maximum = await create(payload(`${search} maximum`, '999999999999.99', category))
    expect(maximum.status).toBe(201)
    const foreign = await create(
      { ...payload(`${search} foreign`, '5', `Foreign ${fixture}`), branchId: otherBranchId },
      'cross',
    )
    const options = await request<{ branches: { id: string }[]; categories: string[] }>(
      'GET',
      '/expenses/options',
      'operator',
    )
    expect(options.body.branches.map((row) => row.id)).toEqual([branchId])
    expect(options.body.categories).toContain(category)
    expect(options.body.categories).not.toContain(`Foreign ${fixture}`)
    expect(
      (await request<{ categories: string[] }>('GET', '/expenses/options', 'clerk')).body
        .categories,
    ).toEqual([])
    const list = await request<{ data: Record<string, string>[]; total: number }>(
      'GET',
      `/expenses?search=${encodeURIComponent(search)}&sort=Amount&order=asc`,
      'operator',
    )
    expect(list.body.data.map((row) => row.id)).toEqual([
      small.body.id,
      medium.body.id,
      maximum.body.id,
    ])
    expect(list.body.data[2]).toMatchObject({
      amount: '999999999999.99',
      Amount: '₱999,999,999,999.99',
    })
    const forgedBranch = await request<{ error: { code: string } }>(
      'GET',
      `/expenses?branchId=${otherBranchId}&search=${encodeURIComponent(search)}`,
      'operator',
    )
    expect(forgedBranch.status).toBe(403)
    expect(forgedBranch.body.error.code).toBe('BRANCH_FORBIDDEN')

    const adminAll = await request<{ data: Record<string, string>[] }>(
      'GET',
      `/expenses?search=${encodeURIComponent(search)}`,
      'cross',
    )
    const adminNorth = await request<{ data: Record<string, string>[] }>(
      'GET',
      `/expenses?branchId=${branchId}&search=${encodeURIComponent(search)}`,
      'cross',
    )
    const adminSouth = await request<{ data: Record<string, string>[] }>(
      'GET',
      `/expenses?branchId=${otherBranchId}&search=${encodeURIComponent(search)}`,
      'cross',
    )
    expect(adminAll.status).toBe(200)
    expect(adminAll.body.data.map((row) => row.id)).toEqual(
      expect.arrayContaining([small.body.id, medium.body.id, maximum.body.id, foreign.body.id]),
    )
    expect(adminNorth.status).toBe(200)
    expect(adminNorth.body.data.map((row) => row.id).sort()).toEqual(
      [small.body.id, medium.body.id, maximum.body.id].sort(),
    )
    expect(adminSouth.status).toBe(200)
    expect(adminSouth.body.data.map((row) => row.id)).toEqual([foreign.body.id])
    expect((await detail(maximum.body.id)).body.expense.amount).toBe('999999999999.99')
  })
})

describe('expense review and independently paginated history', () => {
  it('preserves existing approve-only permission behavior and exposes narrow actual review metadata to readers', async () => {
    const saved = await create()
    expect((await review(saved.body.id, 'Approved', 'Checked purchase', 'approver')).status).toBe(
      200,
    )
    const result = (await detail(saved.body.id, 'viewer')).body
    expect(result.expense).toMatchObject({
      status: 'Approved',
      approvedBy: approverId,
      approvedByName: 'Expense approver',
    })
    expect(result.expense.approvedAt).not.toBeNull()
    expect(result.review).toMatchObject({
      decision: 'Approved',
      note: 'Checked purchase',
      reviewerId: approverId,
      reviewerName: 'Expense approver',
    })
    expect(result.review?.reviewedAt).not.toBeNull()
    expect(result.history).toEqual([])
    expect((await detail(saved.body.id, 'approver')).status).toBe(403)
    expect((await review(saved.body.id, 'Rejected', 'Second decision', 'approver')).status).toBe(
      409,
    )
    const rejected = await create(payload('Unsupported duplicate purchase'))
    expect(
      (await review(rejected.body.id, 'Rejected', 'Duplicate receipt', 'approver')).status,
    ).toBe(200)
    expect((await detail(rejected.body.id, 'viewer')).body).toMatchObject({
      expense: { status: 'Rejected', approvedBy: null, approvedAt: null },
      review: {
        decision: 'Rejected',
        note: 'Duplicate receipt',
        reviewerId: approverId,
        reviewerName: 'Expense approver',
      },
      historyTotal: 0,
    })
  })
  it('locks competing review decisions so one actor wins and exactly one review audit is persisted', async () => {
    const saved = await create()
    const results = await Promise.all([
      review(saved.body.id, 'Approved', 'Accept original'),
      review(saved.body.id, 'Rejected', 'Duplicate expense', 'approver'),
    ])
    expect(results.map((row) => row.status).sort()).toEqual([200, 409])
    const result = (await detail(saved.body.id)).body
    expect(result.historyTotal).toBe(2)
    expect(
      result.history.filter(
        (row) => row.action === 'expense approved' || row.action === 'expense rejected',
      ),
    ).toHaveLength(1)
    expect(result.review?.decision).toBe(result.expense.status)
    expect(result.expense.amount).toBe('125.25')
  })
  it('projects only a known current-status review event and excludes foreign-branch or unrelated audit payloads', async () => {
    const saved = await create()
    await review(saved.body.id, 'Approved', 'Actual checked note', 'approver')
    const events = [
      {
        branchId: otherBranchId,
        action: 'expense approved',
        value: { status: 'Approved', reviewNote: 'Wrong branch private note' },
      },
      {
        branchId,
        action: 'edited expense',
        value: {
          status: 'Approved',
          reviewNote: 'Unrelated decorative note',
          privateField: 'do not project',
        },
      },
      {
        branchId,
        action: 'expense rejected',
        value: { status: 'Rejected', reviewNote: 'Stale status note' },
      },
    ]
    for (const event of events)
      await pool.query(
        "insert into audit_logs(user_id,branch_id,action,entity_type,entity_id,new_value,created_at) values($1,$2,$3,'expenses',$4,$5,clock_timestamp())",
        [actorId, event.branchId, event.action, saved.body.id, event.value],
      )
    const result = (await detail(saved.body.id, 'viewer')).body
    expect(result.review).toMatchObject({
      decision: 'Approved',
      note: 'Actual checked note',
      reviewerId: approverId,
    })
    expect(result.review).not.toHaveProperty('privateField')
    expect(result.history).toEqual([])
    expect((await detail(saved.body.id, 'auditor')).body.historyTotal).toBe(4)
  })
  it('paginates branch-scoped full audit separately from operational metadata', async () => {
    const saved = await create()
    for (let index = 0; index < 24; index++)
      await pool.query(
        "insert into audit_logs(user_id,branch_id,action,entity_type,entity_id,new_value,created_at) values($1,$2,'Historical expense event','expenses',$3,$4,clock_timestamp())",
        [actorId, branchId, saved.body.id, { sequence: index }],
      )
    await pool.query(
      "insert into audit_logs(user_id,branch_id,action,entity_type,entity_id,new_value) values($1,$2,'Foreign audit','expenses',$3,'{}')",
      [actorId, otherBranchId, saved.body.id],
    )
    const first = (await detail(saved.body.id, 'auditor')).body
    const second = (await detail(saved.body.id, 'auditor', '?historyPage=2')).body
    expect(first).toMatchObject({
      historyPage: 1,
      historyPageSize: 20,
      historyTotal: 25,
      review: null,
    })
    expect(first.history).toHaveLength(20)
    expect(second.history).toHaveLength(5)
    expect(new Set([...first.history, ...second.history].map((row) => row.id)).size).toBe(25)
    expect(first.history.every((row) => row.actorName === 'Expense operator')).toBe(true)
    expect((await detail(saved.body.id, 'viewer', '?historyPage=2')).body).toMatchObject({
      history: [],
      historyTotal: 0,
      historyPage: 2,
    })
  })
})

describe('existing fleet expense sources and private proof boundaries', () => {
  it('exposes the actual maintenance parent only with its domain grant and uses the original private proof parent', async () => {
    const saved = await create()
    const parent = await maintenance(saved.body.id)
    const result = (await detail(saved.body.id, 'maintenance-reader')).body
    expect(result.source).toMatchObject({
      entityType: 'vehicle-maintenance',
      id: parent.id,
      reference: parent.reference,
      status: 'Completed',
      vehicleName: `Expense truck ${fixture}`,
      plateNumber: `EXP-${fixture}`,
    })
    expect((await detail(saved.body.id, 'viewer')).body.source).toBeNull()
    expect((await detail(saved.body.id, 'allowance-reader')).body.source).toBeNull()
    const path = `/attachments?entityType=vehicle-maintenance&entityId=${parent.id}`
    expect((await request('GET', path, 'maintenance-reader')).status).toBe(200)
    expect((await request('GET', path, 'viewer')).status).toBe(403)
    expect((await request('GET', path, 'outsider')).status).toBe(404)
  })
  it('keeps auto-approved allowance actor/date authoritative and grants only the actual allowance proof parent', async () => {
    const expenseId = await insertId(
      "insert into expenses(description,category,branch_id,amount,submitted_by,status,approved_by,approved_at) values('Released driver allowance','Driver allowances',$1,125.25,$2,'Approved',$3,'2026-09-29T03:00:00Z') returning id",
      [branchId, actorId, approverId],
    )
    const parent = await allowance(expenseId)
    const result = (await detail(expenseId, 'allowance-reader')).body
    expect(result.source).toMatchObject({
      entityType: 'driver-allowance',
      id: parent.id,
      reference: parent.reference,
      status: 'Released',
      workerName: `Expense worker ${fixture}`,
      paymentType: 'Trip allowance',
      method: 'Cash',
    })
    expect(result.review).toEqual({
      decision: 'Approved',
      note: null,
      reviewerId: approverId,
      reviewerName: 'Expense approver',
      reviewedAt: '2026-09-29T03:00:00.000Z',
    })
    expect((await detail(expenseId, 'viewer')).body.source).toBeNull()
    const path = `/attachments?entityType=driver-allowance&entityId=${parent.id}`
    expect((await request('GET', path, 'allowance-reader')).status).toBe(200)
    expect((await request('GET', path, 'viewer')).status).toBe(403)
    expect((await review(expenseId, 'Rejected', 'Cannot reverse a posted allowance')).status).toBe(
      409,
    )
    expect(
      (
        await pool.query<{ request_key: string | null }>(
          'select request_key from expenses where id=$1',
          [expenseId],
        )
      ).rows[0]?.request_key,
    ).toBeNull()
  })
  it('suppresses cross-branch source corruption and ambiguous existing cross-table links', async () => {
    const foreign = await create()
    await maintenance(foreign.body.id, otherBranchId)
    expect((await detail(foreign.body.id)).body.source).toBeNull()
    const ambiguous = await create()
    await maintenance(ambiguous.body.id)
    await allowance(ambiguous.body.id)
    expect((await detail(ambiguous.body.id)).body.source).toBeNull()
    expect((await detail(ambiguous.body.id, 'maintenance-reader')).body.source).toBeNull()
    expect((await detail(ambiguous.body.id, 'allowance-reader')).body.source).toBeNull()
  })
})
