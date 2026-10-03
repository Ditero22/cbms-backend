import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '@/app.js'
import { pool } from '@/database/client.js'
import { permissionKeys } from '@/database/permissions.js'
import { removeStoredProof } from '@/features/attachments/attachment.storage.js'
import { philippineDate } from '@/shared/philippine-date.js'
import {
  createSessionToken,
  hashSessionToken,
  sessionCookieName,
} from '@/shared/security/session.js'

const fixture = randomUUID().slice(0, 8)
const proofPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=',
  'base64',
)
const managerPermissions = [
  'payroll.read',
  'payroll.create',
  'payroll.update',
  'payroll.process',
  'payroll.pay',
  'payroll.receive',
]
const cleanup = {
  branches: [] as string[],
  employees: [] as string[],
  roles: [] as string[],
  users: [] as string[],
  runs: [] as string[],
  entries: [] as string[],
  attachments: [] as string[],
  objectKeys: [] as string[],
}
const cookies: Record<string, string> = {}
let server: Server
let apiUrl: string
let branchId: string
let otherBranchId: string

type ApiResult<T = Record<string, unknown>> = { status: number; body: T }
type PayrollRun = { id: string; reference: string; status: string }
type PayrollEntry = {
  id: string
  employeeId: string
  branchId: string
  proofAttachmentId: string | null
}

async function insertId(query: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(query, values)
  const id = result.rows[0]?.id
  if (!id) throw new Error('The payroll authorization fixture could not be created.')
  return id
}

async function createManager(label: string, branch: string) {
  const roleId = await insertId('insert into roles(name) values($1) returning id', [
    `Payroll HTTP ${label} ${fixture}`,
  ])
  cleanup.roles.push(roleId)
  for (const permission of managerPermissions) {
    await pool.query('insert into role_permissions(role_id,permission_key) values($1,$2)', [
      roleId,
      permission,
    ])
  }
  const userId = await insertId(
    `insert into users(name,email,password_hash,role_id,branch_id,status)
     values($1,$2,'test-unused',$3,$4,'Active') returning id`,
    [`Payroll ${label}`, `payroll-${label}-${fixture}@example.invalid`, roleId, branch],
  )
  cleanup.users.push(userId)
  const token = createSessionToken()
  await pool.query(
    "insert into user_sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')",
    [userId, hashSessionToken(token)],
  )
  cookies[label] = `${sessionCookieName}=${token}`
}

async function request<T = Record<string, unknown>>(
  method: string,
  path: string,
  manager: 'north' | 'south',
  body?: Record<string, unknown>,
  form?: FormData,
): Promise<ApiResult<T>> {
  const response = await fetch(`${apiUrl}/api/v1${path}`, {
    method,
    headers: {
      Cookie: cookies[manager]!,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(form ? { body: form } : {}),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as T) : ({} as T),
  }
}

function payrollInput(branch: string, employees: string[]) {
  return {
    branchId: branch,
    periodStart: '2026-10-01',
    periodEnd: '2026-10-15',
    requestKey: randomUUID(),
    entries: employees.map((employeeId) => ({
      employeeId,
      payBasis: 'Daily wage',
      units: '5',
      rate: '100.00',
      adjustments: [],
    })),
  }
}

beforeAll(async () => {
  for (const permission of [...managerPermissions, ...permissionKeys]) {
    await pool.query(
      'insert into permissions(key,description) values($1,$1) on conflict(key) do nothing',
      [permission],
    )
  }
  branchId = await insertId('insert into branches(name,code) values($1,$2) returning id', [
    `Payroll North ${fixture}`,
    `pay-n-${fixture}`,
  ])
  otherBranchId = await insertId('insert into branches(name,code) values($1,$2) returning id', [
    `Payroll South ${fixture}`,
    `pay-s-${fixture}`,
  ])
  cleanup.branches.push(branchId, otherBranchId)
  await createManager('north', branchId)
  await createManager('south', otherBranchId)

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('The payroll test server did not start.')
  apiUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  for (const objectKey of cleanup.objectKeys) await removeStoredProof(objectKey)
  if (cleanup.entries.length)
    await pool.query('delete from audit_logs where entity_type=$1 and entity_id=any($2::uuid[])', [
      'payroll-entry',
      cleanup.entries,
    ])
  if (cleanup.runs.length)
    await pool.query('delete from audit_logs where entity_type=$1 and entity_id=any($2::uuid[])', [
      'payroll-run',
      cleanup.runs,
    ])
  if (cleanup.runs.length)
    await pool.query('delete from payroll_entries where payroll_run_id=any($1::uuid[])', [
      cleanup.runs,
    ])
  if (cleanup.runs.length)
    await pool.query('delete from payroll_runs where id=any($1::uuid[])', [cleanup.runs])
  if (cleanup.attachments.length)
    await pool.query('delete from attachments where id=any($1::uuid[])', [cleanup.attachments])
  if (cleanup.employees.length)
    await pool.query('delete from employees where id=any($1::uuid[])', [cleanup.employees])
  if (cleanup.users.length) {
    await pool.query('delete from user_sessions where user_id=any($1::uuid[])', [cleanup.users])
    await pool.query('delete from audit_logs where user_id=any($1::uuid[])', [cleanup.users])
    await pool.query('delete from users where id=any($1::uuid[])', [cleanup.users])
  }
  if (cleanup.roles.length)
    await pool.query('delete from roles where id=any($1::uuid[])', [cleanup.roles])
  if (cleanup.branches.length)
    await pool.query('delete from branches where id=any($1::uuid[])', [cleanup.branches])
})

describe('branch-manager payroll HTTP access', () => {
  it('supports employee payroll and payment proof within one branch while denying cross-branch access', async () => {
    const northEmployees = await Promise.all(
      ['A', 'B'].map((suffix) =>
        insertId(
          `insert into employees(employee_number,name,position,branch_id)
           values($1,$2,'Site worker',$3) returning id`,
          [`PM-N-${suffix}-${fixture}`, `Payroll North Worker ${suffix} ${fixture}`, branchId],
        ),
      ),
    )
    const southEmployee = await insertId(
      `insert into employees(employee_number,name,position,branch_id)
       values($1,$2,'Site worker',$3) returning id`,
      [`PM-S-${fixture}`, `Payroll South Worker ${fixture}`, otherBranchId],
    )
    cleanup.employees.push(...northEmployees, southEmployee)

    const foreignEmployeeRun = await request<{
      error: { code: string }
    }>('POST', '/payroll', 'north', payrollInput(branchId, [southEmployee]))
    expect(foreignEmployeeRun.status).toBe(400)
    expect(foreignEmployeeRun.body.error.code).toBe('INVALID_PAYROLL_EMPLOYEE')

    const northOptions = await request<{ branches: { id: string }[]; employees: { id: string }[] }>(
      'GET',
      '/payroll/options',
      'north',
    )
    expect(northOptions.status).toBe(200)
    expect(northOptions.body.branches.map((branch) => branch.id)).toEqual([branchId])
    expect(northOptions.body.employees.map((employee) => employee.id)).toEqual(northEmployees)
    expect(
      (await request('GET', `/payroll/options?branchId=${otherBranchId}`, 'north')).status,
    ).toBe(403)

    const northRunResponse = await request<PayrollRun>(
      'POST',
      '/payroll',
      'north',
      payrollInput(branchId, northEmployees),
    )
    expect(northRunResponse.status).toBe(201)
    cleanup.runs.push(northRunResponse.body.id)
    const northRun = northRunResponse.body
    const southRunResponse = await request<PayrollRun>(
      'POST',
      '/payroll',
      'south',
      payrollInput(otherBranchId, [southEmployee]),
    )
    expect(southRunResponse.status).toBe(201)
    cleanup.runs.push(southRunResponse.body.id)

    const updated = await request('PATCH', `/payroll/${northRun.id}`, 'north', {
      ...payrollInput(branchId, northEmployees),
      requestKey: undefined,
    })
    expect(updated.status).toBe(200)
    expect((await request('POST', `/payroll/${northRun.id}/process`, 'north', {})).status).toBe(200)

    const northLedger = await request<{
      items: PayrollEntry[]
      total: number
      branches: { id: string }[]
    }>('GET', '/payroll/entries?limit=50', 'north')
    expect(northLedger.status).toBe(200)
    expect(northLedger.body.total).toBe(2)
    expect(northLedger.body.items.map((entry) => entry.branchId)).toEqual([branchId, branchId])
    expect(northLedger.body.branches.map((branch) => branch.id)).toEqual([branchId])
    expect(
      (await request('GET', `/payroll/entries?branchId=${otherBranchId}`, 'north')).status,
    ).toBe(403)

    const southRunDetail = await request('GET', `/payroll/${southRunResponse.body.id}`, 'north')
    expect(southRunDetail.status).toBe(404)
    expect(
      (await request('POST', `/payroll/${southRunResponse.body.id}/process`, 'north', {})).status,
    ).toBe(404)
    const foreignCreate = await request(
      'POST',
      '/payroll',
      'north',
      payrollInput(otherBranchId, [southEmployee]),
    )
    expect(foreignCreate.status).toBe(403)

    const entryId = northLedger.body.items[0]!.id
    const payment = new FormData()
    payment.set(
      'data',
      JSON.stringify({
        paymentDate: philippineDate(),
        paymentMethod: 'Cash',
        paymentReference: 'Cash payroll receipt',
        requestKey: randomUUID(),
      }),
    )
    payment.set('proofFile', new File([proofPng], `payroll-${fixture}.png`, { type: 'image/png' }))
    const paid = await request<{ id: string; status: string; proofAttachmentId: string }>(
      'POST',
      `/payroll/entries/${entryId}/pay-with-proof`,
      'north',
      undefined,
      payment,
    )
    expect(paid.status).toBe(200)
    expect(paid.body).toMatchObject({ id: entryId, status: 'Paid' })
    expect(paid.body.proofAttachmentId).toBeTruthy()
    cleanup.attachments.push(paid.body.proofAttachmentId)
    cleanup.entries.push(...northLedger.body.items.map((entry) => entry.id))
    const attachment = await pool.query<{ object_key: string }>(
      'select object_key from attachments where id=$1',
      [paid.body.proofAttachmentId],
    )
    cleanup.objectKeys.push(attachment.rows[0]!.object_key)

    const preview = await fetch(
      `${apiUrl}/api/v1/attachments/${paid.body.proofAttachmentId}/content`,
      {
        headers: { Cookie: cookies.north! },
      },
    )
    expect(preview.status).toBe(200)
    expect(preview.headers.get('content-type')).toMatch(/image\/png/)
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(proofPng)

    const receipt = await request('POST', `/payroll/entries/${entryId}/receive`, 'north', {
      receivedAt: new Date().toISOString(),
      acknowledgement: 'Employee confirmed receiving the payment.',
    })
    expect(receipt.status).toBe(200)
    const paidEntry = await request<{ entry: PayrollEntry & { paymentStatus: string } }>(
      'GET',
      `/payroll/entries/${entryId}`,
      'north',
    )
    expect(paidEntry.body.entry).toMatchObject({
      id: entryId,
      paymentStatus: 'Received',
      proofAttachmentId: paid.body.proofAttachmentId,
    })

    const foreignEntry = await request<{ items: PayrollEntry[] }>(
      'GET',
      `/payroll/entries?branchId=${otherBranchId}`,
      'south',
    )
    expect(foreignEntry.status).toBe(200)
    expect(foreignEntry.body.items).toHaveLength(1)
    const southLedger = await request<{ items: PayrollEntry[] }>('GET', '/payroll/entries', 'south')
    expect(southLedger.body.items).toHaveLength(1)
    expect(
      (await request('GET', `/payroll/entries/${southLedger.body.items[0]!.id}`, 'north')).status,
    ).toBe(404)
  })
})
