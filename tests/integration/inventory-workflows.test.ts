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
import type { InventoryRecord } from '@/features/inventory/inventory-detail.repository.js'

type ApiError = { error: { code: string; message: string } }
type Movement = {
  id: string
  transactionType: string
  quantityDelta: string
  stockDelta: string | null
  reservedDelta: string | null
  referenceType: string | null
  referenceId: string | null
  referenceLabel: string | null
  note: string | null
  performedByName: string
  createdAt: string
}
type History = {
  id: string
  action: string
  oldValue: { quantity?: string; reorderLevel?: string } | null
  newValue: { quantity?: string; reorderLevel?: string }
  actorName: string
  createdAt: string
}
type Detail = {
  inventory: InventoryRecord
  latestAddition: { id: string; quantity: string } | null
  movements: Movement[]
  movementPage: number
  movementPageSize: number
  movementTotal: number
  movementTypes: string[]
  history: History[]
  historyPage: number
  historyPageSize: number
  historyTotal: number
}
type Stock = { id: string; productId: string; branchId: string }
type CreatedOrder = { id: string }

let server: Server,
  apiUrl: string,
  branchId: string,
  otherBranchId: string,
  actorId: string,
  customerId: string,
  crossAdminId: string | undefined
const cookies: Record<string, string> = {}
const fixture = randomUUID().slice(0, 8)
let productSequence = 0
const insertId = async (sql: string, values: unknown[]) =>
  (await pool.query<{ id: string }>(sql, values)).rows[0]!.id

async function account(
  label: string,
  accountBranch: string | null,
  permissions: string[],
  crossBranch = false,
) {
  const roleId = await insertId('insert into roles(name, is_system) values($1, $2) returning id', [
    `Inventory HTTP ${label} ${fixture}`,
    crossBranch ? 1 : 0,
  ])
  for (const permission of permissions) {
    await pool.query('insert into role_permissions(role_id,permission_key) values($1,$2)', [
      roleId,
      permission,
    ])
  }
  const userId = await insertId(
    "insert into users(name,email,password_hash,role_id,branch_id,is_cross_branch) values($1,$2,'unused-test',$3,$4,$5) returning id",
    [
      `Inventory ${label}`,
      `inventory-${label}-${fixture}@example.invalid`,
      roleId,
      accountBranch,
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

async function stock(quantity = '100.000', reserved = '0.000', branch = branchId): Promise<Stock> {
  productSequence++
  const productId = await insertId(
    "insert into products(name,sku,category,unit,unit_price) values($1,$2,'Materials','ton','10.00') returning id",
    [`Inventory material ${fixture} ${productSequence}`, `INV-${fixture}-${productSequence}`],
  )
  const id = await insertId(
    'insert into inventory(product_id,branch_id,quantity,reserved_quantity,reorder_level) values($1,$2,$3,$4,10) returning id',
    [productId, branch, quantity, reserved],
  )
  return { id, productId, branchId: branch }
}

const detail = (target: Stock, label = 'operator', query = '') =>
  request<Detail>('GET', `/inventory/${target.id}${query}`, label)
const adjustment = (
  target: Stock,
  quantityDelta: string | number,
  label = 'operator',
  extra: Record<string, unknown> = {},
) =>
  request<{ id: string; quantity: string }>('POST', '/inventory/adjustments', label, {
    productId: target.productId,
    branchId: target.branchId,
    quantityDelta,
    ...extra,
  })
const reorder = (
  target: Stock,
  reorderLevel: string | number,
  label = 'operator',
  extra: Record<string, unknown> = {},
) =>
  request<InventoryRecord>('PATCH', `/inventory/${target.id}/reorder`, label, {
    reorderLevel,
    ...extra,
  })

const correction = (
  target: Stock,
  transactionId: string,
  correctedQuantity: string,
  reason: string,
  requestKey: string,
  label = 'operator',
) =>
  request<{ id: string; quantity: string } | ApiError>(
    'POST',
    `/inventory/${target.id}/corrections`,
    label,
    { transactionId, correctedQuantity, reason, requestKey },
  )

beforeAll(async () => {
  for (const key of permissionKeys) {
    await pool.query(
      'insert into permissions(key,description) values($1,$2) on conflict do nothing',
      [key, `Inventory HTTP ${key}`],
    )
  }
  branchId = await insertId('insert into branches(name,code) values($1,$2) returning id', [
    `Inventory North ${fixture}`,
    `in-${fixture}`,
  ])
  otherBranchId = await insertId('insert into branches(name,code) values($1,$2) returning id', [
    `Inventory South ${fixture}`,
    `is-${fixture}`,
  ])
  customerId = await insertId('insert into customers(name,branch_id) values($1,$2) returning id', [
    `Inventory customer ${fixture}`,
    branchId,
  ])
  actorId = await account('operator', branchId, permissionKeys)
  await account('viewer', branchId, ['inventory.read'])
  await account('auditor', branchId, ['inventory.read', 'audit.read'])
  await account('adjuster', branchId, ['inventory.adjust'])
  await account('reorderer', branchId, ['inventory.reorder'])
  await account('outsider', otherBranchId, permissionKeys)
  await account('unassigned', null, permissionKeys)
  await account('unprivileged', branchId, [])
  crossAdminId = await account('cross', null, permissionKeys, true)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Inventory HTTP server did not start.')
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

describe('inventory HTTP permissions and validation', () => {
  it('enforces authentication, read/reorder grants, assigned branch and hidden foreign records', async () => {
    const target = await stock()
    expect((await request<ApiError>('GET', `/inventory/${target.id}`)).status).toBe(401)
    expect((await detail(target, 'unprivileged')).status).toBe(403)
    expect((await detail(target, 'outsider')).status).toBe(404)
    expect((await reorder(target, 1, 'outsider')).status).toBe(404)
    expect((await reorder(target, 1, 'viewer')).status).toBe(403)
    expect((await reorder(target, 1, 'reorderer')).status).toBe(403)
    expect((await detail(target, 'unassigned')).status).toBe(403)
    expect((await reorder(target, 1, 'unassigned')).status).toBe(403)
    expect((await adjustment(target, 1, 'unassigned')).status).toBe(403)
    expect((await adjustment(target, 1, 'outsider')).status).toBe(403)
    expect((await request('GET', '/inventory/options', 'unassigned')).status).toBe(403)
    expect((await request('GET', '/inventory', 'unassigned')).status).toBe(403)
    const branchOptions = await request<{ branches: { id: string }[] }>(
      'GET',
      `/inventory/options?branchId=${otherBranchId}`,
      'viewer',
    )
    expect(branchOptions.status).toBe(200)
    expect(branchOptions.body.branches.map((branch) => branch.id)).toEqual([branchId])
    const administratorOptions = await request<{ branches: { id: string }[] }>(
      'GET',
      '/inventory/options',
      'cross',
    )
    expect(administratorOptions.status).toBe(200)
    expect(administratorOptions.body.branches.map((branch) => branch.id)).toEqual(
      expect.arrayContaining([branchId, otherBranchId]),
    )
    expect((await detail(target, 'cross')).status).toBe(200)
    expect((await reorder(target, '2.375', 'cross')).status).toBe(200)
  })
  it('rejects malformed records, filters, precision, stock fields and invalid adjustment keys', async () => {
    const target = await stock()
    expect((await request('GET', '/inventory/not-a-uuid', 'operator')).status).toBe(400)
    for (const query of [
      '?movementPage=0',
      '?historyPage=2.5',
      '?dateFrom=2026-02-30',
      '?dateFrom=2026-10-02&dateTo=2026-10-01',
      '?limit=1000',
    ])
      expect((await detail(target, 'operator', query)).status).toBe(400)
    for (const quantity of ['-1', '1.0001', '1000000.001'])
      expect((await reorder(target, quantity)).status).toBe(400)
    expect((await reorder(target, 3, 'operator', { quantity: '999' })).status).toBe(400)
    for (const quantity of ['0', '1.0001', '1000000.001', '1e3'])
      expect((await adjustment(target, quantity)).status).toBe(400)
    expect((await adjustment(target, 1, 'operator', { requestKey: 'arbitrary' })).status).toBe(400)
    expect((await detail(target)).body.inventory.quantity).toBe('100.000')
  })
  it('keeps archived stock history readable and blocks new writes to archived or inactive targets', async () => {
    const target = await stock()
    await adjustment(target, '1.001')
    await pool.query('update products set deleted_at=now() where id=$1', [target.productId])
    const archived = await detail(target)
    expect(archived.body.inventory.productStatus).toBe('Archived')
    expect(archived.body.movementTotal).toBe(1)
    expect((await adjustment(target, '1')).status).toBe(404)
    expect((await reorder(target, '1')).status).toBe(409)
    const inactive = await stock()
    await pool.query("update products set status='Inactive' where id=$1", [inactive.productId])
    expect((await detail(inactive)).body.inventory.productStatus).toBe('Inactive')
    expect((await adjustment(inactive, '1')).status).toBe(404)
  })
})

describe('latest stock addition correction', () => {
  it('appends an audited correction, preserves the original movement and retries safely', async () => {
    const target = await stock('100.000')
    const addition = await adjustment(target, '5.000', 'operator', { requestKey: randomUUID() })
    expect(addition.status).toBe(201)
    const before = await detail(target)
    const latest = before.body.latestAddition
    expect(latest).not.toBeNull()
    expect(latest!.quantity).toBe('5.000')
    const requestKey = randomUUID()
    const corrected = await correction(
      target,
      latest!.id,
      '5.750',
      'Supplier delivery count was entered incorrectly.',
      requestKey,
    )
    expect(corrected.status).toBe(201)
    expect((corrected.body as { quantity: string }).quantity).toBe('105.750')
    const retry = await correction(
      target,
      latest!.id,
      '5.750',
      'Supplier delivery count was entered incorrectly.',
      requestKey,
    )
    expect(retry).toMatchObject({ status: 201, body: corrected.body })
    expect(
      (await correction(target, latest!.id, '5.750', 'different reason', requestKey)).status,
    ).toBe(409)
    const after = await detail(target, 'auditor')
    expect(after.body.inventory.quantity).toBe('105.750')
    expect(after.body.movements.filter((movement) => movement.id === latest!.id)).toHaveLength(1)
    expect(after.body.movements[0]).toMatchObject({
      transactionType: 'Correction',
      quantityDelta: '0.750',
      referenceType: 'StockCorrection',
      referenceId: latest!.id,
    })
    expect(after.body.history[0]).toMatchObject({ action: 'corrected latest stock addition' })
    expect(after.body.history[0]?.oldValue).toMatchObject({ additionQuantity: '5.000' })
    expect(after.body.history[0]?.newValue).toMatchObject({
      additionQuantity: '5.750',
      reason: 'Supplier delivery count was entered incorrectly.',
    })
  })

  it('rejects older additions, later stock activity, branch access and invalid correction reasons', async () => {
    const target = await stock('25.000')
    const older = await adjustment(target, '2.000', 'operator', { requestKey: randomUUID() })
    const newer = await adjustment(target, '3.000', 'operator', { requestKey: randomUUID() })
    expect(older.status).toBe(201)
    expect(newer.status).toBe(201)
    const detailBefore = await detail(target)
    const olderId = (older.body as { id: string }).id
    const latestId = (newer.body as { id: string }).id
    expect(
      (await correction(target, olderId, '2.500', 'Correct older entry', randomUUID())).status,
    ).toBe(409)
    const valid = await correction(target, latestId, '3.500', 'Correct latest entry', randomUUID())
    expect(valid.status).toBe(201)
    const secondAddition = await adjustment(target, '1.000', 'operator', {
      requestKey: randomUUID(),
    })
    expect(secondAddition.status).toBe(201)
    const staleLatest = await correction(
      target,
      latestId,
      '3.750',
      'Stock changed after entry',
      randomUUID(),
    )
    expect(staleLatest.status).toBe(409)
    expect(
      (await correction(target, '00000000-0000-0000-0000-000000000000', '1', '', randomUUID()))
        .status,
    ).toBe(400)
    const fresh = await detail(target)
    expect(
      (
        await correction(
          target,
          fresh.body.latestAddition!.id,
          '2.000',
          'Forged branch correction',
          randomUUID(),
          'outsider',
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await correction(
          target,
          fresh.body.latestAddition!.id,
          '2.000',
          'No correction permission',
          randomUUID(),
          'viewer',
        )
      ).status,
    ).toBe(403)
  })
})

describe('exact atomic stock maintenance', () => {
  it('applies positive and negative thousandths without changing reserved stock and audits row IDs', async () => {
    const target = await stock('10.375', '2.125')
    expect(
      (await adjustment(target, '0.001', 'adjuster', { note: 'Count correction' })).body.quantity,
    ).toBe('10.376')
    const negative = await adjustment(target, '-0.251', 'operator', { note: 'Count correction' })
    expect(negative.status).toBe(201)
    expect(negative.body.quantity).toBe('10.125')
    const result = (await detail(target)).body
    expect(result.inventory).toMatchObject({
      quantity: '10.125',
      reservedQuantity: '2.125',
      availableQuantity: '8.000',
      reorderLevel: '10.000',
    })
    expect(result.movements[0]).toMatchObject({
      quantityDelta: '-0.251',
      stockDelta: '-0.251',
      reservedDelta: '0.000',
      performedByName: 'Inventory operator',
    })
    expect(result.history[0]).toMatchObject({
      oldValue: { quantity: '10.376' },
      newValue: { quantity: '10.125' },
    })
    const ids = await pool.query<{ entity_id: string }>(
      "select entity_id from audit_logs where entity_type='inventory' and entity_id=$1",
      [target.id],
    )
    expect(ids.rowCount).toBe(2)
    expect((await detail(target, 'viewer')).body.history).toEqual([])
    expect((await detail(target, 'viewer')).body.historyTotal).toBe(0)
  })
  it('rolls failed reductions back including absent-row initialization, movement and audit writes', async () => {
    const target = await stock('5.000', '4.000')
    expect((await adjustment(target, '-1.001')).status).toBe(409)
    expect((await detail(target)).body).toMatchObject({
      inventory: { quantity: '5.000', reservedQuantity: '4.000' },
      movementTotal: 0,
      historyTotal: 0,
    })
    expect((await adjustment(target, '-1')).body.quantity).toBe('4.000')
    const missing = await stock('0')
    await pool.query('delete from inventory where id=$1', [missing.id])
    expect((await adjustment(missing, '-0.001')).status).toBe(409)
    expect(
      (
        await pool.query('select id from inventory where product_id=$1 and branch_id=$2', [
          missing.productId,
          missing.branchId,
        ])
      ).rowCount,
    ).toBe(0)
    expect((await adjustment(missing, '0.125')).status).toBe(201)
    const maximum = await stock('99999999999.999')
    const overflow = await request<ApiError>('POST', '/inventory/adjustments', 'operator', {
      productId: maximum.productId,
      branchId: maximum.branchId,
      quantityDelta: '0.001',
    })
    expect(overflow.status).toBe(409)
    expect(overflow.body.error.code).toBe('STOCK_QUANTITY_LIMIT')
    expect((await detail(maximum)).body).toMatchObject({
      inventory: { quantity: '99999999999.999' },
      movementTotal: 0,
      historyTotal: 0,
    })
  })
  it('serializes competing reductions so available stock is never overspent', async () => {
    const target = await stock('5.000', '2.000')
    const results = await Promise.all([adjustment(target, '-2.000'), adjustment(target, '-2.000')])
    expect(results.map((row) => row.status).sort()).toEqual([201, 409])
    expect((await detail(target)).body).toMatchObject({
      inventory: { quantity: '3.000', reservedQuantity: '2.000', availableQuantity: '1.000' },
      movementTotal: 1,
      historyTotal: 1,
    })
  })
  it('replays concurrent adjustment retries once and rejects changed payloads or actors', async () => {
    const target = await stock()
    const requestKey = randomUUID()
    const results = await Promise.all([
      adjustment(target, '0.125', 'operator', { requestKey, note: 'Counted' }),
      adjustment(target, 0.125, 'operator', {
        requestKey: requestKey.toUpperCase(),
        note: 'Counted',
      }),
    ])
    expect(results.every((row) => row.status === 201)).toBe(true)
    expect(results[0]!.body.id).toBe(results[1]!.body.id)
    expect((await detail(target)).body).toMatchObject({
      inventory: { quantity: '100.125' },
      movementTotal: 1,
      historyTotal: 1,
    })
    expect(
      (await adjustment(target, '0.126', 'operator', { requestKey, note: 'Counted' })).status,
    ).toBe(409)
    expect(
      (await adjustment(target, '0.125', 'operator', { requestKey, note: 'Different' })).status,
    ).toBe(409)
    expect(
      (await adjustment(target, '0.125', 'cross', { requestKey, note: 'Counted' })).status,
    ).toBe(409)
    expect(
      (await adjustment(target, '0.125', 'unprivileged', { requestKey, note: 'Counted' })).status,
    ).toBe(403)
    const retryKey = randomUUID()
    expect((await adjustment(target, '-999', 'operator', { requestKey: retryKey })).status).toBe(
      409,
    )
    expect((await adjustment(target, '0.001', 'operator', { requestKey: retryKey })).status).toBe(
      201,
    )
  })
  it('maintains inclusive reorder status, supports zero and serializes audit before/after values', async () => {
    const target = await stock('10', '2')
    expect((await detail(target)).body.inventory.status).toBe('Low stock')
    expect((await reorder(target, '9.999')).body).toMatchObject({
      status: 'In stock',
      quantity: '10.000',
      reservedQuantity: '2.000',
      availableQuantity: '8.000',
    })
    const concurrent = await Promise.all([reorder(target, '5.125'), reorder(target, '8.375')])
    expect(concurrent.every((row) => row.status === 200)).toBe(true)
    const result = (await detail(target)).body
    expect(result.historyTotal).toBe(3)
    expect(result.history[0]!.oldValue?.reorderLevel).toBe(result.history[1]!.newValue.reorderLevel)
    expect(result.history[0]!.newValue.reorderLevel).toBe(result.inventory.reorderLevel)
    expect((await reorder(target, '0')).body.reorderLevel).toBe('0.000')
    const unchanged = await reorder(target, '0')
    expect(unchanged.status).toBe(200)
    expect((await detail(target)).body.historyTotal).toBe(4)
    expect((await reorder(target, '1000000')).body.reorderLevel).toBe('1000000.000')
    expect((await detail(target)).body.movementTotal).toBe(0)
  })
})

describe('real movement and audit history', () => {
  it('exposes stable stock IDs and sorts quantity columns numerically within the account branch', async () => {
    const small = await stock('2.125', '1.000')
    const large = await stock('10.125', '2.000')
    const foreign = await stock('7.125', '0.000', otherBranchId)
    const search = `Inventory sort ${fixture}`
    await pool.query('update products set name=$2 where id=any($1::uuid[])', [
      [small.productId, large.productId, foreign.productId],
      search,
    ])
    const list = await request<{ data: Record<string, string>[]; total: number }>(
      'GET',
      `/inventory?search=${encodeURIComponent(search)}&sort=On%20hand&order=asc`,
      'viewer',
    )
    expect(list.status).toBe(200)
    expect(list.body.total).toBe(2)
    expect(list.body.data.map((row) => row.id)).toEqual([small.id, large.id])
    expect(list.body.data.map((row) => row.id)).not.toContain(foreign.id)
    expect(list.body.data[0]).toMatchObject({
      productId: small.productId,
      branchId,
      quantity: '2.125',
      reservedQuantity: '1.000',
      availableQuantity: '1.125',
      'On hand': '2.125 ton',
      Reserved: '1.000 ton',
      Available: '1.125 ton',
    })
    const available = await request<{ data: Record<string, string>[] }>(
      'GET',
      `/inventory?search=${encodeURIComponent(search)}&sort=Available&order=desc`,
      'viewer',
    )
    expect(available.body.data.map((row) => row.id)).toEqual([large.id, small.id])
    const outsiderList = await request<{ data: { id: string }[]; total: number }>(
      'GET',
      `/inventory?search=${encodeURIComponent(search)}`,
      'outsider',
    )
    expect(outsiderList.body.total).toBe(1)
    expect(outsiderList.body.data.map((row) => row.id)).toEqual([foreign.id])
    expect(
      (
        await request(
          'GET',
          `/inventory?search=${encodeURIComponent(search)}&branchId=${otherBranchId}`,
          'viewer',
        )
      ).status,
    ).toBe(403)

    const administratorAll = await request<{ data: { id: string }[] }>(
      'GET',
      `/inventory?search=${encodeURIComponent(search)}`,
      'cross',
    )
    expect(administratorAll.body.data.map((row) => row.id)).toEqual(
      expect.arrayContaining([small.id, large.id, foreign.id]),
    )
    const administratorBranch = await request<{ data: { id: string }[] }>(
      'GET',
      `/inventory?search=${encodeURIComponent(search)}&branchId=${otherBranchId}`,
      'cross',
    )
    expect(administratorBranch.body.data.map((row) => row.id)).toEqual([foreign.id])
  })
  it('paginates deterministically and filters by type and inclusive Manila business dates', async () => {
    const target = await stock()
    const ids: string[] = []
    for (let index = 0; index < 43; index++) {
      ids.push(
        await insertId(
          "insert into inventory_transactions(product_id,branch_id,transaction_type,quantity_delta,performed_by,created_at) values($1,$2,$3,'0.125',$4,'2026-09-30T16:30:00Z') returning id",
          [
            target.productId,
            target.branchId,
            index < 42 ? 'Adjustment' : 'Legacy movement',
            actorId,
          ],
        ),
      )
    }
    await pool.query(
      "insert into inventory_transactions(product_id,branch_id,transaction_type,quantity_delta,performed_by,created_at) values($1,$2,'Adjustment',1,$3,'2026-09-30T15:59:59Z'),($1,$2,'Adjustment',1,$3,'2026-10-01T16:00:00Z')",
      [target.productId, target.branchId, actorId],
    )
    const query = '?dateFrom=2026-10-01&dateTo=2026-10-01'
    const first = (await detail(target, 'operator', query)).body
    const second = (await detail(target, 'operator', `${query}&movementPage=2`)).body
    const third = (await detail(target, 'operator', `${query}&movementPage=3`)).body
    expect(first).toMatchObject({
      movementTotal: 43,
      movementPage: 1,
      movementPageSize: 20,
      movementTypes: ['Adjustment', 'Legacy movement'],
    })
    expect(first.movements).toHaveLength(20)
    expect(second.movements).toHaveLength(20)
    expect(third.movements).toHaveLength(3)
    const all = [...first.movements, ...second.movements, ...third.movements]
    expect(all.map((row) => row.id)).toEqual(ids.sort().reverse())
    expect(all.find((row) => row.transactionType === 'Legacy movement')).toMatchObject({
      quantityDelta: '0.125',
      stockDelta: null,
      reservedDelta: null,
    })
    const filtered = (await detail(target, 'operator', `${query}&movementType=Adjustment`)).body
    expect(filtered.movementTotal).toBe(42)
    expect(filtered.movements.every((row) => row.transactionType === 'Adjustment')).toBe(true)
    expect(
      (await detail(target, 'operator', '?movementType=NeverRecorded')).body.movements,
    ).toEqual([])
  })
  it('includes old product-keyed branch audits without leaking the same product from another branch', async () => {
    const target = await stock()
    for (let index = 0; index < 22; index++)
      await pool.query(
        "insert into audit_logs(user_id,branch_id,action,entity_type,entity_id,new_value) values($1,$2,'adjusted inventory','inventory',$3,$4)",
        [actorId, branchId, target.productId, { quantity: String(index) }],
      )
    await pool.query(
      "insert into audit_logs(user_id,branch_id,action,entity_type,entity_id,new_value) values($1,$2,'adjusted inventory','inventory',$3,'{}')",
      [actorId, otherBranchId, target.productId],
    )
    const first = (await detail(target, 'auditor')).body
    const second = (await detail(target, 'auditor', '?historyPage=2')).body
    expect(first.historyTotal).toBe(22)
    expect(first.history).toHaveLength(20)
    expect(second.history).toHaveLength(2)
    expect(new Set([...first.history, ...second.history].map((row) => row.id)).size).toBe(22)
    expect(first.history.every((row) => row.actorName === 'Inventory operator')).toBe(true)
  })
  it('resolves order and transfer references only with read grants and matching parent branch', async () => {
    const target = await stock()
    const orderId = await insertId(
      'insert into orders(order_number,customer_id,branch_id,created_by) values($1,$2,$3,$4) returning id',
      [`INV-order-${fixture}`, customerId, branchId, actorId],
    )
    const foreignOrderId = await insertId(
      'insert into orders(order_number,customer_id,branch_id,created_by) values($1,$2,$3,$4) returning id',
      [`INV-other-${fixture}`, customerId, otherBranchId, actorId],
    )
    const transferId = await insertId(
      "insert into inventory_transfers(reference,from_branch_id,to_branch_id,status,requested_by) values($1,$2,$3,'Completed',$4) returning id",
      [`INV-transfer-${fixture}`, branchId, otherBranchId, actorId],
    )
    for (const [referenceType, referenceId] of [
      ['Order', orderId],
      ['Order', foreignOrderId],
      ['Transfer', transferId],
    ]) {
      await pool.query(
        'insert into inventory_transactions(product_id,branch_id,transaction_type,quantity_delta,reference_type,reference_id,performed_by) values($1,$2,$3,1,$4,$5,$6)',
        [
          target.productId,
          branchId,
          referenceType === 'Transfer' ? 'TRANSFER_IN' : 'RESERVATION_CREATED',
          referenceType,
          referenceId,
          actorId,
        ],
      )
    }
    const visible = (await detail(target)).body.movements
    expect(visible.find((row) => row.referenceId === orderId)?.referenceLabel).toBe(
      `INV-order-${fixture}`,
    )
    expect(visible.find((row) => row.referenceId === transferId)?.referenceLabel).toBe(
      `INV-transfer-${fixture}`,
    )
    expect(
      visible.filter((row) => row.referenceType === 'Order' && row.referenceLabel === null),
    ).toMatchObject([{ referenceId: null }])
    const hidden = (await detail(target, 'viewer')).body.movements
    expect(hidden.every((row) => row.referenceId === null && row.referenceLabel === null)).toBe(
      true,
    )
    expect(hidden.map((row) => row.quantityDelta)).toEqual(['1.000', '1.000', '1.000'])
  })
  it('distinguishes actual order reservation and cancellation releases from on-hand movements', async () => {
    const target = await stock('10')
    const order = await request<CreatedOrder>('POST', '/orders', 'operator', {
      customerId,
      branchId,
      items: [{ productId: target.productId, quantity: '2.375' }],
    })
    expect(order.status).toBe(201)
    const reserved = (await detail(target)).body
    expect(reserved.inventory).toMatchObject({
      quantity: '10.000',
      reservedQuantity: '2.375',
      availableQuantity: '7.625',
    })
    expect(reserved.movements).toMatchObject([
      {
        transactionType: 'RESERVATION_CREATED',
        stockDelta: '0.000',
        reservedDelta: '2.375',
        referenceId: order.body.id,
      },
    ])
    const cancelled = await request('POST', `/orders/${order.body.id}/cancel`, 'operator', {
      reason: 'customer request',
      notes: 'Customer cancelled before delivery',
    })
    expect(cancelled.status).toBe(200)
    const released = (await detail(target)).body
    expect(released.inventory).toMatchObject({
      quantity: '10.000',
      reservedQuantity: '0.000',
      availableQuantity: '10.000',
    })
    expect(released.movements[0]).toMatchObject({
      transactionType: 'RESERVATION_RELEASED',
      quantityDelta: '-2.375',
      stockDelta: '0.000',
      reservedDelta: '-2.375',
    })
    expect(released.movements.every((row) => row.referenceLabel !== null)).toBe(true)
  })
  it('shows real delivery stock and reservation consumption followed by a classified return', async () => {
    const target = await stock('10')
    const order = await request<CreatedOrder>('POST', '/orders', 'operator', {
      customerId,
      branchId,
      items: [{ productId: target.productId, quantity: '2' }],
    })
    expect(order.status).toBe(201)
    const orderDetail = await request<{ items: { id: string }[] }>(
      'GET',
      `/orders/${order.body.id}`,
      'operator',
    )
    const orderItemId = orderDetail.body.items[0]!.id
    const delivery = await request<{ id: string }>('POST', '/deliveries', 'operator', {
      orderId: order.body.id,
      destination: 'Inventory integration site',
      items: [{ orderItemId, quantity: '1' }],
    })
    expect(delivery.status).toBe(201)
    for (const status of ['In Transit', 'Delivered'])
      expect(
        (await request('PATCH', `/deliveries/${delivery.body.id}/status`, 'operator', { status }))
          .status,
      ).toBe(200)
    const delivered = (await detail(target)).body
    expect(delivered.inventory).toMatchObject({
      quantity: '9.000',
      reservedQuantity: '1.000',
      availableQuantity: '8.000',
    })
    expect(delivered.movements[0]).toMatchObject({
      transactionType: 'DELIVERY_OUT',
      stockDelta: '-1.000',
      reservedDelta: '-1.000',
    })
    const returned = await request<{ id: string }>(
      'POST',
      `/orders/${order.body.id}/returns`,
      'operator',
      {
        requestKey: randomUUID(),
        deliveryId: delivery.body.id,
        reason: 'Material returned resalable',
        items: [{ orderItemId, quantity: '1' }],
      },
    )
    expect(returned.status).toBe(201)
    expect(
      (await request('PATCH', `/returns/${returned.body.id}/approve`, 'operator')).status,
    ).toBe(200)
    expect(
      (
        await request('PATCH', `/returns/${returned.body.id}/receive`, 'operator', {
          items: [{ orderItemId, condition: 'Resalable', acceptedQuantity: '1' }],
        })
      ).status,
    ).toBe(200)
    const received = (await detail(target)).body
    expect(received.inventory).toMatchObject({
      quantity: '10.000',
      reservedQuantity: '1.000',
      availableQuantity: '9.000',
    })
    expect(received.movements[0]).toMatchObject({
      transactionType: 'RETURN_IN',
      stockDelta: '1.000',
      reservedDelta: '0.000',
      referenceId: returned.body.id,
    })
    expect(received.movements[0]!.referenceLabel).not.toBeNull()
  })
})
