import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '@/app.js'
import { env } from '@/config/env.js'
import { pool } from '@/database/client.js'
import {
  createSessionToken,
  hashSessionToken,
  sessionCookieName,
} from '@/shared/security/session.js'
import { maxProofBytes } from '@/features/attachments/attachment.schemas.js'
import { readProof, removeStoredProof } from '@/features/attachments/attachment.storage.js'
import {
  createPayrollRun,
  getPayrollRunDetail,
  markPayrollEntryPaid,
  processPayrollRun,
} from '@/features/payroll/payroll.service.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=',
  'base64',
)
const pdf = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF')
const fixture = randomUUID().slice(0, 8)
const ownedKeys = new Set<string>()
const ownedAttachments = new Set<string>()
const cookies: Record<string, string> = {}
let server: Server
let baseUrl: string
let branchId: string
let otherBranchId: string
let userId: string
let paymentId: string
let otherPaymentId: string
let maintenanceId: string
let cancelledMaintenanceId: string
let allowanceId: string
let pendingAllowanceId: string
let payrollRunId: string
let payrollEntryId: string
type Metadata = {
  id: string
  fileName: string
  mimeType: string
  fileSize: number
  uploadedByName: string
  createdAt: string
}

async function insertId(sql: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(sql, values)
  if (!result.rows[0]) throw new Error('Private-proof fixture could not be created.')
  return result.rows[0].id
}

async function createAccount(label: string, branch: string | null, permissions: string[]) {
  const role = await insertId('insert into roles(name) values($1) returning id', [
    `Private proof ${label} ${fixture}`,
  ])
  for (const permission of permissions)
    await pool.query('insert into role_permissions(role_id,permission_key) values($1,$2)', [
      role,
      permission,
    ])
  const user = await insertId(
    `insert into users(name,email,password_hash,role_id,branch_id,status) values($1,$2,'test-unused',$3,$4,'Active') returning id`,
    [`Proof ${label}`, `proof-${label}-${fixture}@example.invalid`, role, branch],
  )
  const token = createSessionToken()
  await pool.query(
    "insert into user_sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')",
    [user, hashSessionToken(token)],
  )
  cookies[label] = `${sessionCookieName}=${token}`
  return user
}

async function request(
  method: string,
  endpoint: string,
  account?: string,
  bytes?: Buffer,
  mimeType = 'image/png',
  fileName = 'proof.png',
) {
  return fetch(`${baseUrl}/api/v1${endpoint}`, {
    method,
    headers: {
      ...(account ? { Cookie: cookies[account] } : {}),
      ...(bytes ? { 'Content-Type': mimeType, 'x-file-name': encodeURIComponent(fileName) } : {}),
    },
    ...(bytes ? { body: new Uint8Array(bytes) } : {}),
  })
}

async function upload(
  entityType = 'payment',
  entityId = paymentId,
  bytes = png,
  mime = 'image/png',
  fileName = 'proof.png',
) {
  const result = await request(
    'POST',
    `/attachments?entityType=${entityType}&entityId=${entityId}`,
    'operator',
    bytes,
    mime,
    fileName,
  )
  expect(result.status).toBe(201)
  const body = (await result.json()) as { id: string }
  const storage = await pool.query<{ object_key: string }>(
    'select object_key from attachments where id=$1',
    [body.id],
  )
  ownedAttachments.add(body.id)
  ownedKeys.add(storage.rows[0]!.object_key)
  return { id: body.id, key: storage.rows[0]!.object_key }
}

beforeAll(async () => {
  // File tests must never exercise an external bucket or a development database.
  expect(env.nodeEnv).toBe('test')
  expect(env.r2.enabled).toBe(false)
  expect(new URL(env.databaseUrl).pathname.slice(1)).toMatch(
    /^cbms_(?:test|integration_[a-z0-9_]+)$/,
  )
  const permissions = [
    'payments.read',
    'payments.create',
    'payroll.read',
    'payroll.create',
    'payroll.process',
    'payroll.pay',
    'payroll.receive',
    'vehicles.maintenance',
    'expenses.read',
    'driver-allowances.read',
    'driver-allowances.release',
    'driver-allowances.receive',
  ]
  for (const permission of permissions)
    await pool.query(
      'insert into permissions(key,description) values($1,$1) on conflict do nothing',
      [permission],
    )
  branchId = await insertId('insert into branches(name,code) values($1,$2) returning id', [
    `Proof branch ${fixture}`,
    `pf-${fixture}`,
  ])
  otherBranchId = await insertId('insert into branches(name,code) values($1,$2) returning id', [
    `Proof other branch ${fixture}`,
    `pfo-${fixture}`,
  ])
  userId = await createAccount('operator', branchId, permissions)
  await createAccount('reader', branchId, ['payments.read', 'driver-allowances.read'])
  await createAccount('denied', branchId, [])
  await createAccount('other', otherBranchId, permissions)
  await createAccount('unassigned', null, permissions)
  await createAccount('maintenance-no-finance', branchId, ['vehicles.maintenance'])
  await createAccount('payroll-reader', branchId, ['payroll.read'])
  const customer = await insertId(
    'insert into customers(name,branch_id) values($1,$2) returning id',
    [`Proof customer ${fixture}`, branchId],
  )
  for (const [branch, label] of [
    [branchId, 'north'],
    [otherBranchId, 'south'],
  ] as const) {
    const order = await insertId(
      `insert into orders(order_number,customer_id,branch_id,total_amount,status,created_by) values($1,$2,$3,'10.00','Processing',$4) returning id`,
      [`PROOF-${fixture}-${label}`, customer, branch, userId],
    )
    const payment = await insertId(
      `insert into payments(reference,order_id,method,amount,recorded_by) values($1,$2,'Cash','10.00',$3) returning id`,
      [`PROOF-PAY-${fixture}-${label}`, order, userId],
    )
    if (label === 'north') paymentId = payment
    else otherPaymentId = payment
  }
  const vehicle = await insertId(
    `insert into vehicles(name,plate_number,vehicle_type,status,branch_id) values($1,$2,'Water Truck','Available',$3) returning id`,
    [`Proof truck ${fixture}`, `PFP-${fixture}`, branchId],
  )
  maintenanceId = await insertId(
    `insert into vehicle_maintenance(reference,vehicle_id,branch_id,maintenance_type,description,status,created_by) values($1,$2,$3,'Inspection','Proof test repair','In Progress',$4) returning id`,
    [`PROOF-MNT-${fixture}`, vehicle, branchId, userId],
  )
  cancelledMaintenanceId = await insertId(
    `insert into vehicle_maintenance(reference,vehicle_id,branch_id,maintenance_type,description,status,created_by) values($1,$2,$3,'Inspection','Cancelled proof test','Cancelled',$4) returning id`,
    [`PROOF-CANCEL-${fixture}`, vehicle, branchId, userId],
  )
  const employee = await insertId(
    `insert into employees(employee_number,name,position,branch_id,status,is_driver) values($1,$2,'Driver',$3,'Active',1) returning id`,
    [`PFE-${fixture}`, `Proof driver ${fixture}`, branchId],
  )
  allowanceId = await insertId(
    `insert into driver_allowances(reference,worker_id,branch_id,payment_type,amount,payment_timing,method,status,created_by,released_at) values($1,$2,$3,'Trip allowance','100.00','Immediate','Cash','Released',$4,now()) returning id`,
    [`PROOF-ALW-${fixture}`, employee, branchId, userId],
  )
  pendingAllowanceId = await insertId(
    `insert into driver_allowances(reference,worker_id,branch_id,payment_type,amount,payment_timing,method,status,created_by) values($1,$2,$3,'Trip allowance','100.00','Pending release','Cash','Pending',$4) returning id`,
    [`PROOF-PENDING-${fixture}`, employee, branchId, userId],
  )
  const payrollUser: AuthenticatedUser = {
    id: userId,
    name: `Proof operator ${fixture}`,
    email: `proof-operator-${fixture}@example.invalid`,
    role: `Private proof operator ${fixture}`,
    branchId,
    branch: `Proof branch ${fixture}`,
    isCrossBranch: false,
    permissions,
  }
  const payrollContext = { user: payrollUser, ipAddress: null, requestId: null }
  const payrollRun = await createPayrollRun(
    {
      branchId,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-15',
      entries: [
        {
          employeeId: employee,
          payBasis: 'Daily wage',
          units: '1',
          rate: '100.00',
          adjustments: [],
        },
      ],
    },
    payrollContext,
  )
  payrollRunId = payrollRun.id
  payrollEntryId = (await getPayrollRunDetail(payrollRunId, payrollUser)).entries[0]!.id
  await processPayrollRun(payrollRunId, payrollContext)
  await markPayrollEntryPaid(
    payrollEntryId,
    { paymentDate: new Date().toISOString().slice(0, 10), paymentMethod: 'Cash' },
    payrollContext,
  )
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Private-proof server did not listen.')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  // Remove only exact random storage keys and metadata created by this file.
  try {
    for (const key of ownedKeys) await removeStoredProof(key)
    if (ownedAttachments.size)
      await pool.query('delete from attachments where id=any($1::uuid[])', [
        Array.from(ownedAttachments),
      ])
    if (payrollRunId) {
      await pool.query('delete from payroll_entries where payroll_run_id=$1', [payrollRunId])
      await pool.query('delete from payroll_runs where id=$1', [payrollRunId])
    }
  } finally {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    await pool.end()
  }
})

describe('authenticated private financial proof storage', () => {
  it('enforces authentication, read/create permissions and actual parent branch before uploads', async () => {
    const endpoint = `/attachments?entityType=payment&entityId=${paymentId}`
    expect((await request('GET', endpoint)).status).toBe(401)
    expect((await request('POST', endpoint, undefined, png)).status).toBe(401)
    expect((await request('GET', endpoint, 'denied')).status).toBe(403)
    expect((await request('POST', endpoint, 'reader', png)).status).toBe(403)
    expect((await request('GET', endpoint, 'other')).status).toBe(404)
    expect((await request('POST', endpoint, 'other', png)).status).toBe(404)
    expect((await request('GET', endpoint, 'unassigned')).status).toBe(403)
    expect(
      (
        await request(
          'GET',
          `/attachments?entityType=payment&entityId=${otherPaymentId}`,
          'operator',
        )
      ).status,
    ).toBe(404)
    expect(
      (await request('GET', '/attachments?entityType=users&entityId=' + paymentId, 'operator'))
        .status,
    ).toBe(400)
    expect(
      (await request('GET', '/attachments?entityType=payment&entityId=invalid', 'operator')).status,
    ).toBe(400)
  })

  it('stores receipt proofs with safe random keys and returns only authorized public metadata', async () => {
    const saved = await upload('payment', paymentId, png, 'image/png', 'gcash-receipt.png')
    expect(saved.key).toMatch(/^local\/[a-f0-9-]{36}$/)
    expect(saved.key).not.toContain('gcash')
    const list = await request(
      'GET',
      `/attachments?entityType=payment&entityId=${paymentId}`,
      'reader',
    )
    expect(list.status).toBe(200)
    const body = (await list.json()) as { items: Metadata[] }
    const metadata = body.items.find((item) => item.id === saved.id)!
    expect(metadata).toMatchObject({
      fileName: 'gcash-receipt.png',
      mimeType: 'image/png',
      fileSize: png.length,
      uploadedByName: 'Proof operator',
    })
    expect(Object.keys(metadata).sort()).toEqual([
      'createdAt',
      'fileName',
      'fileSize',
      'id',
      'mimeType',
      'uploadedByName',
    ])
    expect(JSON.stringify(body)).not.toContain(saved.key)
    const audit = await pool.query(
      `select user_id,branch_id,entity_type,entity_id,new_value from audit_logs where entity_type='payment' and entity_id=$1 and action='uploaded proof'`,
      [paymentId],
    )
    expect(audit.rows[0]).toMatchObject({
      user_id: userId,
      branch_id: branchId,
      entity_type: 'payment',
      entity_id: paymentId,
      new_value: expect.objectContaining({ attachmentId: saved.id, fileName: 'gcash-receipt.png' }),
    })
    expect(JSON.stringify(audit.rows[0].new_value)).not.toContain(saved.key)
  })

  it('authorizes payroll proofs by entry branch and payroll grants', async () => {
    const endpoint = `/attachments?entityType=payroll-entry&entityId=${payrollEntryId}`
    expect((await request('GET', endpoint, 'payroll-reader')).status).toBe(200)
    expect((await request('GET', endpoint, 'denied')).status).toBe(403)
    expect((await request('GET', endpoint, 'other')).status).toBe(404)
    expect((await request('POST', endpoint, 'payroll-reader', png)).status).toBe(403)
    expect((await request('POST', endpoint, 'other', png)).status).toBe(404)

    const saved = await upload(
      'payroll-entry',
      payrollEntryId,
      png,
      'image/png',
      'payroll-proof.png',
    )
    const listed = await request('GET', endpoint, 'payroll-reader')
    expect(listed.status).toBe(200)
    expect(((await listed.json()) as { items: Metadata[] }).items.map((item) => item.id)).toContain(
      saved.id,
    )
    expect(
      (await request('GET', `/attachments/${saved.id}/content`, 'payroll-reader')).status,
    ).toBe(200)
    expect((await request('GET', `/attachments/${saved.id}/content`, 'other')).status).toBe(404)

    const confirmed = await fetch(`${baseUrl}/api/v1/payroll/entries/${payrollEntryId}/receive`, {
      method: 'POST',
      headers: { Cookie: cookies.operator, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receivedAt: new Date().toISOString(), proofAttachmentId: saved.id }),
    })
    expect(confirmed.status).toBe(200)
    const entry = await pool.query<{ payment_status: string }>(
      'select payment_status from payroll_entries where id=$1',
      [payrollEntryId],
    )
    expect(entry.rows[0]?.payment_status).toBe('Received')
  })

  it('serves downloads privately with no-store, nosniff and safe content-disposition', async () => {
    const saved = await upload(
      'payment',
      paymentId,
      pdf,
      'application/pdf',
      'signed acknowledgement.pdf',
    )
    const response = await request('GET', `/attachments/${saved.id}/content`, 'reader')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(response.headers.get('content-disposition')).toContain('attachment;')
    expect(response.headers.get('content-disposition')).toContain('signed%20acknowledgement.pdf')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(pdf)
    expect((await request('GET', `/attachments/${saved.id}/content`)).status).toBe(401)
    expect((await request('GET', `/attachments/${saved.id}/content`, 'denied')).status).toBe(403)
    expect((await request('GET', `/attachments/${saved.id}/content`, 'other')).status).toBe(404)
    expect((await request('GET', '/attachments/invalid/content', 'reader')).status).toBe(400)
  })

  it('rejects executable/spoofed types, mismatched extensions, paths and empty files', async () => {
    const endpoint = `/attachments?entityType=payment&entityId=${paymentId}`
    for (const [bytes, mime, fileName] of [
      [Buffer.from('MZ executable'), 'application/x-msdownload', 'proof.exe'],
      [Buffer.from('MZ executable'), 'image/png', 'proof.png'],
      [png, 'image/png', 'proof.exe'],
      [png, 'image/jpeg', 'proof.jpg'],
      [png, 'image/png', '../proof.png'],
      [png, 'image/png', 'proof\n.png'],
      [png.subarray(0, 8), 'image/png', 'proof.png'],
      [Buffer.alloc(0), 'image/png', 'proof.png'],
    ] as const) {
      const result = await request('POST', endpoint, 'operator', bytes, mime, fileName)
      expect(result.status, `${mime} / ${fileName}`).toBe(400)
    }
  })

  it('rejects files larger than 10 MB before persisting any metadata', async () => {
    const large = Buffer.alloc(maxProofBytes + 1)
    png.copy(large)
    const result = await request(
      'POST',
      `/attachments?entityType=payment&entityId=${paymentId}`,
      'operator',
      large,
    )
    expect(result.status).toBe(413)
    const payload = (await result.json()) as { error: { code: string } }
    expect(payload.error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('enforces maintenance finance permissions and released allowance parent states', async () => {
    expect(
      (
        await request(
          'GET',
          `/attachments?entityType=vehicle-maintenance&entityId=${maintenanceId}`,
          'maintenance-no-finance',
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await request(
          'POST',
          `/attachments?entityType=vehicle-maintenance&entityId=${cancelledMaintenanceId}`,
          'operator',
          png,
        )
      ).status,
    ).toBe(409)
    expect(
      (
        await request(
          'POST',
          `/attachments?entityType=driver-allowance&entityId=${pendingAllowanceId}`,
          'operator',
          png,
        )
      ).status,
    ).toBe(409)
    expect(
      (
        await request(
          'POST',
          `/attachments?entityType=driver-allowance&entityId=${allowanceId}`,
          'reader',
          png,
        )
      ).status,
    ).toBe(403)
    await upload('vehicle-maintenance', maintenanceId, png, 'image/png', 'repair-receipt.png')
    await upload('driver-allowance', allowanceId, png, 'image/png', 'worker-received.png')
    expect(
      (
        await request(
          'POST',
          `/attachments?entityType=payment&entityId=${allowanceId}`,
          'operator',
          png,
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await request(
          'POST',
          `/attachments?entityType=driver-allowance&entityId=${paymentId}`,
          'operator',
          png,
        )
      ).status,
    ).toBe(404)
  })

  it('refuses damaged, missing or traversal storage references without disclosing paths', async () => {
    const saved = await upload()
    await pool.query('update attachments set file_size=1 where id=$1', [saved.id])
    const damaged = await request('GET', `/attachments/${saved.id}/content`, 'operator')
    expect(damaged.status).toBe(503)
    expect(((await damaged.json()) as { error: { code: string } }).error.code).toBe(
      'PROOF_STORAGE_INVALID',
    )
    await pool.query('update attachments set file_size=$2 where id=$1', [saved.id, png.length])
    await pool.query("update attachments set object_key='../outside' where id=$1", [saved.id])
    const traversal = await request('GET', `/attachments/${saved.id}/content`, 'operator')
    expect(traversal.status).toBe(404)
    const body = await traversal.text()
    expect(body).not.toContain(env.localUploadDir)
    expect(body).not.toContain('../outside')
    await pool.query('update attachments set object_key=$2 where id=$1', [saved.id, saved.key])
    await removeStoredProof(saved.key)
    expect((await request('GET', `/attachments/${saved.id}/content`, 'operator')).status).toBe(404)
    await expect(readProof('local/../../secret')).rejects.toMatchObject({ code: 'PROOF_NOT_FOUND' })
  })

  it('rolls back attachment metadata and exact local file when audit persistence fails', async () => {
    const trigger = `proof_audit_guard_${fixture}`
    const before = await readdir(path.resolve(env.localUploadDir))
    await pool.query(
      `create function ${trigger}() returns trigger language plpgsql as $$ begin if new.entity_type='payment' and new.entity_id='${paymentId}'::uuid and new.action='uploaded proof' then raise exception 'Isolated proof audit fault'; end if; return new; end $$`,
    )
    await pool.query(
      `create trigger ${trigger} before insert on audit_logs for each row execute function ${trigger}()`,
    )
    try {
      const countBefore = await pool.query<{ count: string }>(
        "select count(*)::text as count from attachments where entity_type='payment' and entity_id=$1",
        [paymentId],
      )
      expect(
        (
          await request(
            'POST',
            `/attachments?entityType=payment&entityId=${paymentId}`,
            'operator',
            png,
          )
        ).status,
      ).toBe(500)
      const countAfter = await pool.query<{ count: string }>(
        "select count(*)::text as count from attachments where entity_type='payment' and entity_id=$1",
        [paymentId],
      )
      expect(countAfter.rows[0]?.count).toBe(countBefore.rows[0]?.count)
      expect((await readdir(path.resolve(env.localUploadDir))).sort()).toEqual(before.sort())
    } finally {
      await pool.query(`drop trigger ${trigger} on audit_logs`)
      await pool.query(`drop function ${trigger}()`)
    }
  })
})
