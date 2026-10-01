import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { Server } from 'node:http'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import app from '@/app.js'
import { env } from '@/config/env.js'
import { pool } from '@/database/client.js'
import { permissionKeys } from '@/database/permissions.js'
import { TransactionCommitError } from '@/database/transaction.js'
import {
  createSessionToken,
  hashSessionToken,
  sessionCookieName,
} from '@/shared/security/session.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { recordPaymentWithProof } from '@/features/payments/payment.service.js'
import {
  createPayrollRun,
  getPayrollRunDetail,
  processPayrollRun,
} from '@/features/payroll/payroll.service.js'
import { validateProofInput } from '@/features/attachments/proof-input.js'
import * as storage from '@/features/attachments/attachment.storage.js'
import { paymentProofForm, paymentProofPng } from './financial-proof-fixture.js'

const fixture = randomUUID().slice(0, 8)
let server: Server,
  apiUrl: string,
  branchId: string,
  otherBranchId: string,
  actorId: string,
  customerId: string,
  productId: string
const cookies: Record<string, string> = {}
const users: Record<string, AuthenticatedUser> = {}
const grants = [
  'payments.read',
  'payments.create',
  'payroll.read',
  'payroll.create',
  'payroll.update',
  'payroll.process',
  'payroll.pay',
  'payroll.receive',
]
const proof = validateProofInput('payment-proof.png', 'image/png', paymentProofPng, true)
const paymentDate = '2024-01-01'
async function id(sql: string, values: unknown[]) {
  return (await pool.query<{ id: string }>(sql, values)).rows[0]!.id
}
async function account(
  label: string,
  branch: string | null,
  permissions: string[],
  global = false,
) {
  const roleId = await id('insert into roles(name,is_system) values($1,$2) returning id', [
    `Financial proof ${label} ${fixture}`,
    global ? 1 : 0,
  ])
  for (const key of permissions)
    await pool.query('insert into role_permissions(role_id,permission_key) values($1,$2)', [
      roleId,
      key,
    ])
  const userId = await id(
    "insert into users(name,email,password_hash,role_id,branch_id,is_cross_branch) values($1,$2,'unused-fixture',$3,$4,$5) returning id",
    [`Proof ${label}`, `proof-${label}-${fixture}@example.invalid`, roleId, branch, global ? 1 : 0],
  )
  const token = createSessionToken()
  await pool.query(
    "insert into user_sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')",
    [userId, hashSessionToken(token)],
  )
  cookies[label] = `${sessionCookieName}=${token}`
  users[label] = {
    id: userId,
    name: `Proof ${label}`,
    email: `proof-${label}-${fixture}@example.invalid`,
    role: label,
    branchId: branch,
    branch: label,
    isCrossBranch: global,
    permissions,
  }
  return userId
}
async function request(
  method: string,
  route: string,
  actor = 'manager',
  body?: FormData | Record<string, unknown>,
) {
  const multipart = body instanceof FormData
  const response = await fetch(`${apiUrl}/api/v1${route}`, {
    method,
    headers: {
      Cookie: cookies[actor]!,
      ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: await response.json() }
}
async function makeOrder(branch = branchId) {
  const orderId = await id(
    "insert into orders(order_number,customer_id,branch_id,total_amount,status,created_by) values($1,$2,$3,100,'Processing',$4) returning id",
    [`FP-${randomUUID()}`, customerId, branch, actorId],
  )
  await pool.query(
    'insert into order_items(order_id,product_id,quantity,unit_price,line_total) values($1,$2,1,100,100)',
    [orderId, productId],
  )
  return orderId
}
async function makeRun(branch = branchId, count = 1) {
  const employeeIds = []
  for (let index = 0; index < count; index++)
    employeeIds.push(
      await id(
        "insert into employees(employee_number,name,position,branch_id) values($1,$2,'Driver',$3) returning id",
        [`FP-${randomUUID()}`, `Employee ${fixture} ${index}`, branch],
      ),
    )
  const context = { user: users.admin!, ipAddress: null, requestId: null }
  const run = await createPayrollRun(
    {
      branchId: branch,
      periodStart: '2024-01-01',
      periodEnd: '2024-01-31',
      entries: employeeIds.map((employeeId) => ({
        employeeId,
        payBasis: 'Salary' as const,
        units: '1',
        rate: '1000.00',
        adjustments: [
          {
            kind: 'earning' as const,
            type: 'Allowance' as const,
            amount: '100.00',
            notes: 'Driver compensation',
          },
        ],
      })),
    },
    context,
  )
  await processPayrollRun(run.id, context)
  return (await getPayrollRunDetail(run.id, users.admin!)).entries.map(
    (entry) => entry.id as string,
  )
}
beforeAll(async () => {
  for (const key of permissionKeys)
    await pool.query(
      'insert into permissions(key,description) values($1,$1) on conflict do nothing',
      [key],
    )
  branchId = await id('insert into branches(name,code) values($1,$2) returning id', [
    `Proof North ${fixture}`,
    `fpn-${fixture}`,
  ])
  otherBranchId = await id('insert into branches(name,code) values($1,$2) returning id', [
    `Proof South ${fixture}`,
    `fps-${fixture}`,
  ])
  actorId = await account('manager', branchId, grants)
  await account('other', otherBranchId, grants)
  await account('reader', branchId, ['payments.read', 'payroll.read'])
  await account('admin', null, grants, true)
  customerId = await id('insert into customers(name,branch_id) values($1,$2) returning id', [
    `Proof customer ${fixture}`,
    branchId,
  ])
  productId = await id(
    "insert into products(name,sku,category,unit,unit_price) values($1,$2,'Materials','piece',100) returning id",
    [`Proof product ${fixture}`, `fp-${fixture}`],
  )
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Financial proof test API did not start.')
  apiUrl = `http://127.0.0.1:${address.port}`
})
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  await pool.end()
})

it('requires proof for HTTP writes and enforces payment grants and branch scope', async () => {
  const orderId = await makeOrder()
  expect(
    (await request('POST', '/payments', 'manager', { orderId, amount: '10', method: 'Cash' })).body
      .error.code,
  ).toBe('PAYMENT_PROOF_REQUIRED')
  expect(
    (
      await request(
        'POST',
        '/payments/with-proof',
        'reader',
        paymentProofForm({ orderId, amount: '10', method: 'Cash' }),
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await request(
        'POST',
        '/payments/with-proof',
        'other',
        paymentProofForm({ orderId, amount: '10', method: 'Cash' }),
      )
    ).status,
  ).toBe(403)
  const malformed = paymentProofForm({ orderId, amount: '10', method: 'Cash' })
  malformed.delete('proofFile')
  expect((await request('POST', '/payments/with-proof', 'manager', malformed)).status).toBe(400)
  const oversized = paymentProofForm(
    { orderId, amount: '10', method: 'Cash' },
    Buffer.alloc(11 * 1024 * 1024 + 1),
  )
  expect((await request('POST', '/payments/with-proof', 'manager', oversized)).status).toBe(413)
})

it('commits customer payment, one private proof and both audit records together and replays unchanged concurrent requests', async () => {
  const orderId = await makeOrder(),
    requestKey = randomUUID()
  const values = {
    orderId,
    amount: '10.00',
    method: 'Cash',
    paymentDate,
    requestKey,
    notes: 'Receipt at payment',
  }
  const results = await Promise.all([
    request('POST', '/payments/with-proof', 'manager', paymentProofForm(values)),
    request('POST', '/payments/with-proof', 'manager', paymentProofForm(values)),
  ])
  expect(results.map((result) => result.status)).toEqual([201, 201])
  expect(results[0]!.body).toEqual(results[1]!.body)
  const paymentId = results[0]!.body.id
  const attachments = await pool.query(
    'select id,object_key as key from attachments where entity_id=$1',
    [paymentId],
  )
  expect(attachments.rows).toHaveLength(1)
  expect(attachments.rows[0]!.id).toBe(results[0]!.body.proofAttachmentId)
  expect(await storage.readProof(attachments.rows[0]!.key)).toEqual(paymentProofPng)
  const audit = await pool.query(
    'select action from audit_logs where entity_id=$1 order by action',
    [paymentId],
  )
  expect(audit.rows.map((row) => row.action)).toEqual(['recorded payment', 'uploaded proof'])
  expect(
    (
      await request(
        'POST',
        '/payments/with-proof',
        'manager',
        paymentProofForm({ ...values, notes: 'Changed' }),
      )
    ).status,
  ).toBe(409)
  expect(
    (await request('POST', '/payments/with-proof', 'admin', paymentProofForm(values))).status,
  ).toBe(409)
  const changedFile = Buffer.from(paymentProofPng)
  changedFile[30] ^= 1
  expect(
    (
      await request(
        'POST',
        '/payments/with-proof',
        'manager',
        paymentProofForm(values, changedFile),
      )
    ).status,
  ).toBe(409)
  const permitted = await fetch(
    `${apiUrl}/api/v1/attachments/${results[0]!.body.proofAttachmentId}/content`,
    { headers: { Cookie: cookies.reader! } },
  )
  expect(permitted.status).toBe(200)
  expect(Buffer.from(await permitted.arrayBuffer())).toEqual(paymentProofPng)
  const denied = await fetch(
    `${apiUrl}/api/v1/attachments/${results[0]!.body.proofAttachmentId}/content`,
    { headers: { Cookie: cookies.other! } },
  )
  expect(denied.status).toBe(404)
})

it('rolls back the customer payment and removes its exact object when proof audit fails', async () => {
  const orderId = await makeOrder(),
    trigger = `financial_proof_failure_${fixture}`
  const before = (await readdir(path.resolve(env.localUploadDir))).sort()
  await pool.query(
    `create function ${trigger}() returns trigger language plpgsql as $$ begin if new.action='uploaded proof' and new.entity_type='payment' then raise exception 'Isolated proof audit failure'; end if; return new; end $$`,
  )
  await pool.query(
    `create trigger ${trigger} before insert on audit_logs for each row execute function ${trigger}()`,
  )
  try {
    expect(
      (
        await request(
          'POST',
          '/payments/with-proof',
          'manager',
          paymentProofForm({ orderId, amount: '10', method: 'Cash' }),
        )
      ).status,
    ).toBe(500)
    expect(
      (await pool.query('select id from payments where order_id=$1', [orderId])).rows,
    ).toHaveLength(0)
    expect((await readdir(path.resolve(env.localUploadDir))).sort()).toEqual(before)
  } finally {
    await pool.query(`drop trigger ${trigger} on audit_logs`)
    await pool.query(`drop function ${trigger}()`)
  }
})

it('does not commit payment when private object storage fails', async () => {
  const orderId = await makeOrder()
  const fail = vi
    .spyOn(storage, 'saveProof')
    .mockRejectedValueOnce(new Error('Isolated storage failure'))
  try {
    await expect(
      recordPaymentWithProof(
        { orderId, amount: '10', method: 'Cash', paymentDate, requestKey: randomUUID() },
        proof,
        { user: users.manager!, ipAddress: null, requestId: null },
      ),
    ).rejects.toThrow('Isolated storage failure')
    expect(
      (await pool.query('select id from payments where order_id=$1', [orderId])).rows,
    ).toHaveLength(0)
  } finally {
    fail.mockRestore()
  }
})

it('retains a committed proof after a lost COMMIT response and resolves retry to the same payment', async () => {
  const orderId = await makeOrder(),
    values = {
      orderId,
      amount: '10',
      method: 'Cash' as const,
      paymentDate,
      requestKey: randomUUID(),
    }
  const client = await pool.connect(),
    query = client.query.bind(client)
  const interceptQuery = vi
    .spyOn(client, 'query')
    .mockImplementation(async (sql: string, parameters?: unknown[]) => {
      const result = await query(sql, parameters)
      if (sql === 'commit') throw new Error('Isolated lost COMMIT response')
      return result
    })
  const interceptConnect = vi.spyOn(pool, 'connect').mockResolvedValueOnce(client)
  const context = { user: users.manager!, ipAddress: null, requestId: null }
  try {
    await expect(recordPaymentWithProof(values, proof, context)).rejects.toBeInstanceOf(
      TransactionCommitError,
    )
  } finally {
    interceptConnect.mockRestore()
    interceptQuery.mockRestore()
  }
  const replay = await recordPaymentWithProof(values, proof, context)
  const stored = await pool.query('select object_key as key from attachments where id=$1', [
    replay.proofAttachmentId,
  ])
  expect(await storage.readProof(stored.rows[0]!.key)).toEqual(paymentProofPng)
  expect(
    (await pool.query('select id from payments where order_id=$1', [orderId])).rows,
  ).toHaveLength(1)
})

it('lists employee payroll entries across runs with branch, period, status and employee filters', async () => {
  const north = await makeRun(branchId, 2),
    south = await makeRun(otherBranchId)
  const ledger = await request('GET', `/payroll/entries?search=${fixture}&limit=50`, 'admin')
  expect(ledger.status).toBe(200)
  expect(ledger.body.items.map((entry: { id: string }) => entry.id).sort()).toEqual(
    [...north, ...south].sort(),
  )
  expect(ledger.body.items[0]).toMatchObject({
    allowancePay: '100.00',
    netPay: '1100.00',
    paymentStatus: 'Pending',
  })
  const manager = await request('GET', `/payroll/entries?search=${fixture}`, 'reader')
  expect(manager.body.items).toHaveLength(2)
  expect(manager.body.branches).toHaveLength(1)
  expect(
    (await request('GET', `/payroll/entries?branchId=${otherBranchId}`, 'manager')).status,
  ).toBe(403)
  expect((await request('GET', `/payroll/entries/${south[0]}`, 'manager')).status).toBe(404)
  expect(
    (await request('GET', `/payroll/entries?periodStart=2025-01-01&search=${fixture}`, 'admin'))
      .body.total,
  ).toBe(0)
  expect(
    (await request('GET', `/payroll/entries?paymentStatus=Paid&search=${fixture}`, 'admin')).body
      .total,
  ).toBe(0)
})

it('records an employee payment with proof and notes once, rejects altered retries and preserves proof after receipt', async () => {
  const [entryId] = await makeRun(),
    values = {
      paymentDate,
      paymentMethod: 'Cash',
      paymentReference: 'Cash receipt',
      paymentNotes: 'Employee payment proof',
      requestKey: randomUUID(),
    }
  expect(
    (await request('POST', `/payroll/entries/${entryId}/pay`, 'manager', values)).body.error.code,
  ).toBe('PAYMENT_PROOF_REQUIRED')
  expect(
    (
      await request(
        'POST',
        `/payroll/entries/${entryId}/pay-with-proof`,
        'reader',
        paymentProofForm(values),
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await request(
        'POST',
        `/payroll/entries/${entryId}/pay-with-proof`,
        'other',
        paymentProofForm(values),
      )
    ).status,
  ).toBe(404)
  const results = await Promise.all([
    request(
      'POST',
      `/payroll/entries/${entryId}/pay-with-proof`,
      'manager',
      paymentProofForm(values),
    ),
    request(
      'POST',
      `/payroll/entries/${entryId}/pay-with-proof`,
      'manager',
      paymentProofForm(values),
    ),
  ])
  expect(results.map((result) => result.status)).toEqual([200, 200])
  expect(results[0]!.body).toEqual(results[1]!.body)
  const detail = await request('GET', `/payroll/entries/${entryId}`, 'manager')
  expect(detail.body.entry).toMatchObject({
    paymentNotes: values.paymentNotes,
    paymentStatus: 'Paid',
    proofAttachmentId: results[0]!.body.proofAttachmentId,
    paidBy: actorId,
  })
  expect(
    (
      await request(
        'POST',
        `/payroll/entries/${entryId}/pay-with-proof`,
        'manager',
        paymentProofForm({ ...values, paymentReference: 'Changed' }),
      )
    ).status,
  ).toBe(409)
  expect(
    (
      await request(
        'POST',
        `/payroll/entries/${entryId}/pay-with-proof`,
        'admin',
        paymentProofForm(values),
      )
    ).status,
  ).toBe(409)
  const changedFile = Buffer.from(paymentProofPng)
  changedFile[30] ^= 1
  expect(
    (
      await request(
        'POST',
        `/payroll/entries/${entryId}/pay-with-proof`,
        'manager',
        paymentProofForm(values, changedFile),
      )
    ).status,
  ).toBe(409)
  expect(
    (
      await request('POST', `/payroll/entries/${entryId}/receive`, 'manager', {
        receivedAt: '2024-01-01T12:00:00Z',
        proofAttachmentId: results[0]!.body.proofAttachmentId,
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await request(
        'POST',
        `/payroll/entries/${entryId}/pay-with-proof`,
        'manager',
        paymentProofForm(values),
      )
    ).body.proofAttachmentId,
  ).toBe(results[0]!.body.proofAttachmentId)
})

it('restores an unpaid payroll entry and removes its proof when payment audit fails', async () => {
  const [entryId] = await makeRun(),
    trigger = `payroll_proof_failure_${fixture}`
  const before = (await readdir(path.resolve(env.localUploadDir))).sort()
  await pool.query(
    `create function ${trigger}() returns trigger language plpgsql as $$ begin if new.action='recorded payroll payment' and new.entity_id='${entryId}'::uuid then raise exception 'Isolated payroll payment audit failure'; end if; return new; end $$`,
  )
  await pool.query(
    `create trigger ${trigger} before insert on audit_logs for each row execute function ${trigger}()`,
  )
  try {
    const response = await request(
      'POST',
      `/payroll/entries/${entryId}/pay-with-proof`,
      'manager',
      paymentProofForm({ paymentDate, paymentMethod: 'Cash' }),
    )
    expect(response.status).toBe(500)
    expect(
      (
        await pool.query(
          'select payment_status as status,paid_by as actor from payroll_entries where id=$1',
          [entryId],
        )
      ).rows[0],
    ).toEqual({ status: 'Pending', actor: null })
    expect(
      (await pool.query('select id from attachments where entity_id=$1', [entryId])).rows,
    ).toHaveLength(0)
    expect((await readdir(path.resolve(env.localUploadDir))).sort()).toEqual(before)
  } finally {
    await pool.query(`drop trigger ${trigger} on audit_logs`)
    await pool.query(`drop function ${trigger}()`)
  }
})
