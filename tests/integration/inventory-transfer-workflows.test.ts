import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '@/app.js'
import { pool } from '@/database/client.js'
import {
  createSessionToken,
  hashSessionToken,
  sessionCookieName,
} from '@/shared/security/session.js'

type Transfer = { id: string; reference: string; status: string }
type ApiError = { error: { code: string; message: string } }
type TransferInput = {
  fromBranchId: string
  toBranchId: string
  items: { productId: string; quantity: string | number }[]
  note?: string
  requestKey?: string
}

let server: Server
let apiUrl: string
let fromBranchId: string
let toBranchId: string
const fixture = randomUUID().slice(0, 8)
const cookies: Record<string, string> = {}
const systemAdministratorIds: string[] = []
let productSequence = 0

async function insertId(query: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(query, values)
  return result.rows[0]!.id
}

async function account(
  label: string,
  crossBranch: boolean,
  transferGrant = true,
  auditGrant = false,
  branchId = fromBranchId,
) {
  const roleId = await insertId('insert into roles(name, is_system) values($1, $2) returning id', [
    `Transfer ${label} ${fixture}`,
    crossBranch ? 1 : 0,
  ])
  if (transferGrant)
    await pool.query('insert into role_permissions(role_id,permission_key) values($1,$2)', [
      roleId,
      'inventory.transfer',
    ])
  if (auditGrant)
    await pool.query('insert into role_permissions(role_id,permission_key) values($1,$2)', [
      roleId,
      'audit.read',
    ])
  const userId = await insertId(
    `insert into users(name,email,password_hash,role_id,branch_id,is_cross_branch)
     values($1,$2,'unused-test-hash',$3,$4,$5) returning id`,
    [
      `Transfer ${label}`,
      `transfer-${label}-${fixture}@example.invalid`,
      roleId,
      branchId,
      crossBranch ? 1 : 0,
    ],
  )
  if (crossBranch) systemAdministratorIds.push(userId)
  const token = createSessionToken()
  await pool.query(
    "insert into user_sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')",
    [userId, hashSessionToken(token)],
  )
  cookies[label] = `${sessionCookieName}=${token}`
}

async function request<T>(body: Record<string, unknown>, actor = 'operator') {
  const response = await fetch(`${apiUrl}/api/v1/transfers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies[actor] ? { Cookie: cookies[actor] } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as T }
}

async function transferDetail<T>(transferId: string, actor = 'operator') {
  const response = await fetch(`${apiUrl}/api/v1/transfers/${transferId}`, {
    headers: cookies[actor] ? { Cookie: cookies[actor] } : {},
  })
  return { status: response.status, body: (await response.json()) as T }
}

async function transferOptions(actor = 'operator') {
  const response = await fetch(`${apiUrl}/api/v1/transfers/options`, {
    headers: cookies[actor] ? { Cookie: cookies[actor] } : {},
  })
  return { status: response.status, body: (await response.json()) as ApiError }
}

async function product(quantity = '10.000', reserved = '0.000', destination = '0.000') {
  productSequence++
  const productId = await insertId(
    `insert into products(name,sku,category,unit,unit_price)
     values($1,$2,'Materials','ton','10.00') returning id`,
    [`Transfer product ${fixture} ${productSequence}`, `TRF-${fixture}-${productSequence}`],
  )
  await pool.query(
    `insert into inventory(product_id,branch_id,quantity,reserved_quantity)
     values($1,$2,$3,$4),($1,$5,$6,0)`,
    [productId, fromBranchId, quantity, reserved, toBranchId, destination],
  )
  return productId
}

async function stock(productId: string) {
  const result = await pool.query<{ branchId: string; quantity: string; reserved: string }>(
    `select branch_id::text as "branchId",quantity::text as quantity,
            reserved_quantity::text as reserved from inventory where product_id=$1`,
    [productId],
  )
  return {
    source: result.rows.find((row) => row.branchId === fromBranchId),
    destination: result.rows.find((row) => row.branchId === toBranchId),
  }
}

function input(productId: string, extra: Partial<TransferInput> = {}): TransferInput {
  return {
    fromBranchId,
    toBranchId,
    items: [{ productId, quantity: '2.375' }],
    requestKey: randomUUID(),
    ...extra,
  }
}

beforeAll(async () => {
  await pool.query(
    'insert into permissions(key,description) values($1,$2) on conflict do nothing',
    ['inventory.transfer', 'Transfer test permission'],
  )
  await pool.query(
    'insert into permissions(key,description) values($1,$2) on conflict do nothing',
    ['audit.read', 'Audit test permission'],
  )
  fromBranchId = await insertId('insert into branches(name,code) values($1,$2) returning id', [
    `Transfer source ${fixture}`,
    `ts-${fixture}`,
  ])
  toBranchId = await insertId('insert into branches(name,code) values($1,$2) returning id', [
    `Transfer destination ${fixture}`,
    `td-${fixture}`,
  ])
  await account('operator', true, true, true)
  await account('other', true)
  await account('scoped', false)
  await account('destination', false, true, true, toBranchId)
  await account('unprivileged', true, false)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Transfer server did not start.')
  apiUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  if (systemAdministratorIds.length > 0) {
    await pool.query("update users set status = 'Inactive' where id = any($1::uuid[])", [
      systemAdministratorIds,
    ])
  }
  await pool.end()
})

describe('atomic stock transfer retries', () => {
  it('posts a fractional transfer once across concurrent and subsequent retries', async () => {
    const productId = await product()
    const values = input(productId, { note: 'Restock destination' })
    const results = await Promise.all([request<Transfer>(values), request<Transfer>(values)])
    expect(results.map((result) => result.status)).toEqual([201, 201])
    expect(results[0]?.body).toEqual(results[1]?.body)
    const replay = await request<Transfer>(values)
    expect(replay.body).toEqual(results[0]?.body)
    const quantities = await stock(productId)
    expect(quantities.source?.quantity).toBe('7.625')
    expect(quantities.destination?.quantity).toBe('2.375')
    const transferId = results[0]!.body.id
    const counts = await pool.query<{ items: number; movements: number; audits: number }>(
      `select
        (select count(*)::int from inventory_transfer_items where transfer_id=$1) as items,
        (select count(*)::int from inventory_transactions where reference_type='Transfer' and reference_id=$1) as movements,
        (select count(*)::int from audit_logs where entity_type='inventory_transfer' and entity_id=$1) as audits`,
      [transferId],
    )
    expect(counts.rows[0]).toEqual({ items: 1, movements: 2, audits: 1 })
    const detail = await transferDetail<{
      reference: string
      status: string
      note: string | null
      fromBranchName: string
      toBranchName: string
      requestedByName: string | null
      items: { productId: string; quantity: string; unit: string }[]
      history: { action: string }[]
      historyTotal: number
    }>(transferId)
    expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({
      reference: results[0]!.body.reference,
      status: 'Completed',
      note: 'Restock destination',
      fromBranchName: `Transfer source ${fixture}`,
      toBranchName: `Transfer destination ${fixture}`,
      requestedByName: 'Transfer operator',
      items: [{ productId, quantity: '2.375', unit: 'ton' }],
      historyTotal: 1,
      history: [{ action: 'completed inventory transfer' }],
    })
    const sourceScoped = await transferDetail<{
      history: unknown[]
      historyTotal: number
    }>(transferId, 'scoped')
    expect(sourceScoped.status).toBe(200)
    expect(sourceScoped.body).toMatchObject({ history: [], historyTotal: 0 })
    const destinationScoped = await transferDetail<{
      history: { action: string }[]
      historyTotal: number
    }>(transferId, 'destination')
    expect(destinationScoped.status).toBe(200)
    expect(destinationScoped.body.historyTotal).toBe(1)
    expect(destinationScoped.body.history[0]?.action).toBe('completed inventory transfer')
    expect((await transferDetail<ApiError>(transferId, 'anonymous')).status).toBe(401)
    expect((await transferDetail<ApiError>(transferId, 'unprivileged')).status).toBe(403)
  })

  it('recognizes equivalent normalized decimals and reordered product lines', async () => {
    const firstProduct = await product()
    const secondProduct = await product()
    const values = input(firstProduct, {
      items: [
        { productId: firstProduct, quantity: '2.5' },
        { productId: secondProduct, quantity: 1 },
      ],
      note: '  Restock  ',
    })
    const first = await request<Transfer>(values)
    const replay = await request<Transfer>({
      ...values,
      requestKey: values.requestKey!.toUpperCase(),
      items: [
        { productId: secondProduct, quantity: '1.000' },
        { productId: firstProduct, quantity: '0002.500' },
      ],
      note: 'Restock',
    })
    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    expect(replay.body).toEqual(first.body)
    expect((await stock(firstProduct)).source?.quantity).toBe('7.500')
    expect((await stock(secondProduct)).source?.quantity).toBe('9.000')
  })

  it('rejects reused keys with changed branches, quantities, products, notes or actor', async () => {
    const productId = await product()
    const otherProduct = await product()
    const values = input(productId, { note: 'Original' })
    expect((await request<Transfer>(values)).status).toBe(201)
    for (const changed of [
      { ...values, items: [{ productId, quantity: '2.376' }] },
      { ...values, items: [{ productId: otherProduct, quantity: '2.375' }] },
      { ...values, fromBranchId: toBranchId, toBranchId: fromBranchId },
      { ...values, note: 'Changed' },
    ]) {
      const conflict = await request<ApiError>(changed)
      expect(conflict.status).toBe(409)
      expect(conflict.body.error.code).toBe('REQUEST_KEY_CONFLICT')
    }
    const actorConflict = await request<ApiError>(values, 'other')
    expect(actorConflict.status).toBe(409)
    expect(actorConflict.body.error.code).toBe('REQUEST_KEY_CONFLICT')
    expect((await stock(productId)).source?.quantity).toBe('7.625')
    expect((await stock(otherProduct)).source?.quantity).toBe('10.000')
  })

  it('replays a committed result after its source stock is exhausted and product is inactive', async () => {
    const productId = await product('2.375')
    const values = input(productId)
    const first = await request<Transfer>(values)
    expect(first.status).toBe(201)
    await pool.query("update products set status='Inactive' where id=$1", [productId])
    const replay = await request<Transfer>(values)
    expect(replay.status).toBe(201)
    expect(replay.body).toEqual(first.body)
    expect((await stock(productId)).source?.quantity).toBe('0.000')
  })

  it('keeps grants and cross-branch access mandatory even for an existing retry key', async () => {
    const productId = await product()
    const values = input(productId)
    expect((await transferOptions()).status).toBe(200)
    const branchOptions = await transferOptions('scoped')
    expect(branchOptions.status).toBe(403)
    expect(branchOptions.body.error.code).toBe('BRANCH_FORBIDDEN')
    expect((await request<Transfer>(values)).status).toBe(201)
    expect((await request<ApiError>(values, 'anonymous')).status).toBe(401)
    expect((await request<ApiError>(values, 'unprivileged')).status).toBe(403)
    const scoped = await request<ApiError>(values, 'scoped')
    expect(scoped.status).toBe(403)
    expect(scoped.body.error.code).toBe('BRANCH_FORBIDDEN')
  })

  it('rolls back all lines and replay identity on insufficient unreserved stock', async () => {
    const firstProduct = await product('10.000', '5.000')
    const secondProduct = await product('1.000')
    const values = input(firstProduct, {
      items: [
        { productId: firstProduct, quantity: '2.375' },
        { productId: secondProduct, quantity: '1.001' },
      ],
    })
    const failure = await request<ApiError>(values)
    expect(failure.status).toBe(409)
    expect(failure.body.error.code).toBe('INSUFFICIENT_STOCK')
    expect((await stock(firstProduct)).source?.quantity).toBe('10.000')
    expect((await stock(firstProduct)).destination?.quantity).toBe('0.000')
    const stored = await pool.query<{ count: number }>(
      'select count(*)::int as count from inventory_transfers where request_key=$1',
      [values.requestKey],
    )
    expect(stored.rows[0]?.count).toBe(0)
    const corrected = await request<Transfer>({
      ...values,
      items: [{ productId: firstProduct, quantity: '5.000' }],
    })
    expect(corrected.status).toBe(201)
    expect((await stock(firstProduct)).source?.quantity).toBe('5.000')
    expect((await stock(firstProduct)).source?.reserved).toBe('5.000')
  })

  it('prevents distinct concurrent transfers from consuming reserved or negative stock', async () => {
    const productId = await product('10.000', '3.000')
    const results = await Promise.all([
      request<Transfer | ApiError>(input(productId, { items: [{ productId, quantity: '5' }] })),
      request<Transfer | ApiError>(input(productId, { items: [{ productId, quantity: '5' }] })),
    ])
    expect(results.map((result) => result.status).sort()).toEqual([201, 409])
    const quantities = await stock(productId)
    expect(quantities.source?.quantity).toBe('5.000')
    expect(quantities.source?.reserved).toBe('3.000')
    expect(quantities.destination?.quantity).toBe('5.000')
  })

  it('keeps older clients without a retry key working and rejects invalid decimal inputs', async () => {
    const productId = await product()
    expect(
      (
        await request<Transfer>({
          fromBranchId,
          toBranchId,
          items: [{ productId, quantity: 1.125 }],
        })
      ).status,
    ).toBe(201)
    for (const quantity of [true, null, '1e2', '1.0001']) {
      const invalid = await request<ApiError>({
        ...input(productId),
        items: [{ productId, quantity }],
      })
      expect(invalid.status).toBe(400)
      expect(invalid.body.error.code).toBe('VALIDATION_ERROR')
    }
    expect((await stock(productId)).source?.quantity).toBe('8.875')
  })

  it('rolls back source stock and replay identity when destination capacity is exceeded', async () => {
    const productId = await product('10.000', '0.000', '99999999999.999')
    const values = input(productId)
    const failure = await request<ApiError>(values)
    expect(failure.status).toBe(409)
    expect(failure.body.error.code).toBe('STOCK_QUANTITY_LIMIT')
    const quantities = await stock(productId)
    expect(quantities.source?.quantity).toBe('10.000')
    expect(quantities.destination?.quantity).toBe('99999999999.999')
    const saved = await pool.query<{ count: number }>(
      'select count(*)::int as count from inventory_transfers where request_key=$1',
      [values.requestKey],
    )
    expect(saved.rows[0]?.count).toBe(0)
  })

  it('locks opposing transfers in a stable order and preserves their total quantity', async () => {
    const productId = await product('10.000', '0.000', '10.000')
    const results = await Promise.all([
      request<Transfer>(input(productId, { items: [{ productId, quantity: '2.375' }] })),
      request<Transfer>(
        input(productId, {
          fromBranchId: toBranchId,
          toBranchId: fromBranchId,
          items: [{ productId, quantity: '1.125' }],
        }),
      ),
    ])
    expect(results.map((result) => result.status)).toEqual([201, 201])
    const quantities = await stock(productId)
    expect(quantities.source?.quantity).toBe('8.750')
    expect(quantities.destination?.quantity).toBe('11.250')
  })
})
