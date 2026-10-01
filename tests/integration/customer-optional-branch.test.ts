import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '@/app.js'
import { paymentProofForm } from './financial-proof-fixture.js'
import { pool } from '@/database/client.js'
import {
  createSessionToken,
  hashSessionToken,
  sessionCookieName,
} from '@/shared/security/session.js'

type ApiError = { error: { code: string } }
type Created = { id: string }
type CustomerDetail = { id: string; name: string; branchId: string | null }
type ListResult = {
  data: { id: string; branchId: string | null; Branch: string }[]
  total: number
}
type Options = { customers: { id: string; name: string }[]; branches: { id: string }[] }
type Report = { rows: Record<string, string>[] }

const fixture = randomUUID().slice(0, 8)
const scopeSearch = `optional-scope-${fixture}`
const grants = [
  'customers.read',
  'customers.create',
  'customers.update',
  'branches.read',
  'products.read',
  'orders.create',
  'sales.read',
  'payments.read',
  'payments.create',
  'reports.view',
  'reports.export',
  'audit.read',
]
const accounts: Record<string, { id: string; cookie: string }> = {}
let server: Server
let apiUrl: string
let branchId: string
let otherBranchId: string
let inactiveBranchId: string
let ownCustomerId: string
let otherCustomerId: string
let unassignedCustomerId: string
let productId: string

async function insertId(sql: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(sql, values)
  const id = result.rows[0]?.id
  if (!id) throw new Error('Could not create customer branch acceptance fixture.')
  return id
}

async function account(
  label: string,
  assignedBranch: string | null,
  system = false,
  keys = grants,
) {
  const roleId = await insertId('insert into roles (name,is_system) values ($1,$2) returning id', [
    `Customer branch ${label} ${fixture}`,
    system ? 1 : 0,
  ])
  for (const key of keys)
    await pool.query('insert into role_permissions (role_id,permission_key) values ($1,$2)', [
      roleId,
      key,
    ])
  const id = await insertId(
    `insert into users (name,email,password_hash,role_id,branch_id,is_cross_branch)
     values ($1,$2,'unused-test-hash',$3,$4,$5) returning id`,
    [
      `Customer branch ${label}`,
      `customer-branch-${label}-${fixture}@example.invalid`,
      roleId,
      assignedBranch,
      system ? 1 : 0,
    ],
  )
  const token = createSessionToken()
  await pool.query(
    `insert into user_sessions (user_id,token_hash,expires_at)
     values ($1,$2,now()+interval '1 hour')`,
    [id, hashSessionToken(token)],
  )
  accounts[label] = { id, cookie: `${sessionCookieName}=${token}` }
}

async function request<T>(
  method: string,
  path: string,
  actor?: string,
  body?: Record<string, unknown>,
) {
  const payment = method === 'POST' && path === '/payments' && body
  const response = await fetch(`${apiUrl}/api/v1${payment ? '/payments/with-proof' : path}`, {
    method,
    headers: {
      ...(actor ? { Cookie: accounts[actor]!.cookie } : {}),
      ...(body && !payment ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: payment ? paymentProofForm(body) : JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: (await response.json()) as T }
}

async function storedBranch(id: string) {
  const result = await pool.query<{ branchId: string | null }>(
    'select branch_id::text as "branchId" from customers where id=$1',
    [id],
  )
  return result.rows[0]?.branchId
}

async function historicalOrder(branch: string, label: string) {
  const number = `OPT-${fixture}-${label}`
  const id = await insertId(
    `insert into orders (order_number,customer_id,branch_id,total_amount,status,created_by)
     values ($1,$2,$3,'10.00','Processing',$4) returning id`,
    [number, unassignedCustomerId, branch, accounts.admin!.id],
  )
  await pool.query(
    `insert into order_items (order_id,product_id,quantity,unit_price,line_total)
     values ($1,$2,1,'10.00','10.00')`,
    [id, productId],
  )
  return { id, number }
}

beforeAll(async () => {
  for (const key of grants)
    await pool.query(
      'insert into permissions (key,description) values ($1,$1) on conflict do nothing',
      [key],
    )
  branchId = await insertId('insert into branches (name,code) values ($1,$2) returning id', [
    `Optional North ${fixture}`,
    `opt-n-${fixture}`,
  ])
  otherBranchId = await insertId('insert into branches (name,code) values ($1,$2) returning id', [
    `Optional South ${fixture}`,
    `opt-s-${fixture}`,
  ])
  inactiveBranchId = await insertId(
    "insert into branches (name,code,status) values ($1,$2,'Inactive') returning id",
    [`Optional inactive ${fixture}`, `opt-i-${fixture}`],
  )
  await account('admin', null, true)
  await account('north', branchId)
  await account('south', otherBranchId)
  await account('unassigned', null)
  await account('denied', branchId, false, [])
  ownCustomerId = await insertId(
    'insert into customers (name,branch_id) values ($1,$2) returning id',
    [`North ${scopeSearch}`, branchId],
  )
  otherCustomerId = await insertId(
    'insert into customers (name,branch_id) values ($1,$2) returning id',
    [`South ${scopeSearch}`, otherBranchId],
  )
  unassignedCustomerId = await insertId('insert into customers (name) values ($1) returning id', [
    `Unassigned ${scopeSearch}`,
  ])
  productId = await insertId(
    `insert into products (name,sku,category,unit,unit_price)
     values ($1,$2,'Materials','piece','10.00') returning id`,
    [`Optional customer material ${fixture}`, `OPT-P-${fixture}`],
  )
  await pool.query(
    'insert into inventory (product_id,branch_id,quantity) values ($1,$2,100),($1,$3,100)',
    [productId, branchId, otherBranchId],
  )
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Customer branch acceptance server did not listen.')
  apiUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  await pool.end()
})

describe('optional Administrator customer branch and branch isolation', () => {
  it('enforces authentication and create/read grants before accepting optional branch input', async () => {
    expect((await request('POST', '/customers', undefined, { name: 'Unauthorized' })).status).toBe(
      401,
    )
    expect((await request('POST', '/customers', 'denied', { name: 'Forbidden' })).status).toBe(403)
    expect((await request('GET', '/customers', 'denied')).status).toBe(403)
    expect((await request('GET', '/customers/options', 'denied')).status).toBe(403)
  })

  it.each(['omitted', 'null'])(
    'stores an Administrator %s branch as NULL and audits it as unassigned',
    async (mode) => {
      const created = await request<Created>('POST', '/customers', 'admin', {
        name: `Admin ${mode} ${fixture}`,
        ...(mode === 'null' ? { branchId: null } : {}),
      })
      expect(created.status).toBe(201)
      expect(await storedBranch(created.body.id)).toBeNull()
      const audit = await pool.query<{
        branchId: string | null
        record: { branchId: string | null }
      }>(
        `select branch_id::text as "branchId",new_value as record from audit_logs
       where entity_type='customers' and entity_id=$1 and action='created customers'`,
        [created.body.id],
      )
      expect(audit.rows).toEqual([
        { branchId: null, record: expect.objectContaining({ branchId: null }) },
      ])
    },
  )

  it('accepts an active Administrator branch choice and excludes inactive branches from create options', async () => {
    const created = await request<Created>('POST', '/customers', 'admin', {
      name: `Admin assigned ${fixture}`,
      branchId,
    })
    expect(created.status).toBe(201)
    expect(await storedBranch(created.body.id)).toBe(branchId)
    const options = await request<{ branches: { id: string }[] }>(
      'GET',
      '/customers/options',
      'admin',
    )
    expect(options.status).toBe(200)
    expect(options.body.branches.map(({ id }) => id)).toEqual(
      expect.arrayContaining([branchId, otherBranchId]),
    )
    expect(options.body.branches.some(({ id }) => id === inactiveBranchId)).toBe(false)
  })

  it('rejects inactive and unknown Administrator branch choices without inserting a customer', async () => {
    for (const invalidBranch of [inactiveBranchId, randomUUID()]) {
      const name = `Invalid customer ${randomUUID()}`
      const response = await request<ApiError>('POST', '/customers', 'admin', {
        name,
        branchId: invalidBranch,
      })
      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('INVALID_BRANCH')
      expect((await pool.query('select id from customers where name=$1', [name])).rowCount).toBe(0)
    }
  })

  it.each(['omitted', 'null', 'foreign'])(
    'derives the branch account assignment for a %s branch payload',
    async (mode) => {
      const created = await request<Created>('POST', '/customers', 'north', {
        name: `Branch ${mode} ${fixture}`,
        ...(mode === 'null' ? { branchId: null } : {}),
        ...(mode === 'foreign' ? { branchId: otherBranchId } : {}),
      })
      expect(created.status).toBe(201)
      expect(await storedBranch(created.body.id)).toBe(branchId)
    },
  )

  it('requires an actual branch assignment for branch-scoped creation and access', async () => {
    for (const body of [{ name: 'No assignment' }, { name: 'Forged assignment', branchId }]) {
      const created = await request<ApiError>('POST', '/customers', 'unassigned', body)
      expect(created.status).toBe(403)
      expect(created.body.error.code).toBe('BRANCH_REQUIRED')
    }
    expect((await request('GET', '/customers', 'unassigned')).status).toBe(403)
    expect((await request('GET', `/customers/${ownCustomerId}`, 'unassigned')).status).toBe(403)
    expect((await request('GET', '/orders/options', 'unassigned')).status).toBe(403)
  })

  it('filters only unassigned customers for Administrators and rejects unsupported or branch-user filters', async () => {
    const unassigned = await request<ListResult>(
      'GET',
      `/customers?search=${scopeSearch}&branchId=unassigned`,
      'admin',
    )
    expect(unassigned.status).toBe(200)
    expect(unassigned.body.total).toBe(1)
    expect(unassigned.body.data).toEqual([
      expect.objectContaining({ id: unassignedCustomerId, branchId: null, Branch: 'Unassigned' }),
    ])
    const own = await request<ListResult>('GET', `/customers?search=${scopeSearch}`, 'north')
    expect(own.status).toBe(200)
    expect(own.body.data.map(({ id }) => id)).toEqual([ownCustomerId])
    const selected = await request<ListResult>(
      'GET',
      `/customers?search=${scopeSearch}&branchId=${otherBranchId}`,
      'admin',
    )
    expect(selected.body.data.map(({ id }) => id)).toEqual([otherCustomerId])
    expect((await request('GET', '/customers?branchId=unassigned', 'north')).status).toBe(403)
    expect((await request('GET', `/customers?branchId=${otherBranchId}`, 'north')).status).toBe(403)
    expect((await request('GET', '/products?branchId=unassigned', 'admin')).status).toBe(400)
    expect((await request('GET', '/branches?branchId=unassigned', 'admin')).status).toBe(400)
  })

  it('denies unassigned and foreign customer details, updates, and archives to branch users', async () => {
    for (const id of [unassignedCustomerId, otherCustomerId]) {
      expect((await request('GET', `/customers/${id}`, 'north')).status).toBe(404)
      expect(
        (await request('PATCH', `/customers/${id}`, 'north', { name: 'Wrong scope' })).status,
      ).toBe(404)
      expect((await request('PATCH', `/customers/${id}/archive`, 'north', {})).status).toBe(404)
    }
    const detail = await request<CustomerDetail>('GET', `/customers/${ownCustomerId}`, 'north')
    expect(detail.status).toBe(200)
    expect(detail.body.branchId).toBe(branchId)
    const updated = await request<CustomerDetail>('PATCH', `/customers/${ownCustomerId}`, 'north', {
      phone: '555-0142',
    })
    expect(updated.status).toBe(200)
    expect(await storedBranch(ownCustomerId)).toBe(branchId)
  })

  it('retains Administrator lifecycle access to unassigned customers and branch-user archive access to own customers', async () => {
    for (const actor of ['admin', 'north']) {
      const created = await request<Created>('POST', '/customers', actor, {
        name: `Archive ${actor} ${fixture}`,
      })
      expect(created.status).toBe(201)
      expect((await request('GET', `/customers/${created.body.id}`, actor)).status).toBe(200)
      expect(
        (await request('PATCH', `/customers/${created.body.id}`, actor, { phone: '555-0101' }))
          .status,
      ).toBe(200)
      expect(
        (await request('PATCH', `/customers/${created.body.id}/archive`, actor, {})).status,
      ).toBe(200)
      expect((await request('GET', `/customers/${created.body.id}`, actor)).status).toBe(404)
    }
  })

  it('limits order and report customer options to the assigned branch while Administrators can see unassigned customers', async () => {
    for (const path of ['/orders/options', '/reports/options']) {
      const scoped = await request<Options>('GET', path, 'north')
      expect(scoped.status).toBe(200)
      const ids = scoped.body.customers.map(({ id }) => id)
      expect(ids).toContain(ownCustomerId)
      expect(ids).not.toContain(otherCustomerId)
      expect(ids).not.toContain(unassignedCustomerId)
      const admin = await request<Options>('GET', path, 'admin')
      expect(admin.status).toBe(200)
      expect(admin.body.customers.map(({ id }) => id)).toEqual(
        expect.arrayContaining([ownCustomerId, otherCustomerId, unassignedCustomerId]),
      )
    }
  })

  it('rejects forged unassigned or foreign order customers for branch users while allowing Administrator unassigned orders', async () => {
    for (const customerId of [unassignedCustomerId, otherCustomerId]) {
      const denied = await request<ApiError>('POST', '/orders', 'north', {
        customerId,
        branchId,
        items: [{ productId, quantity: 1 }],
      })
      expect(denied.status).toBe(404)
      expect(denied.body.error.code).toBe('CUSTOMER_NOT_FOUND')
    }
    const created = await request<Created>('POST', '/orders', 'admin', {
      customerId: unassignedCustomerId,
      branchId,
      requestKey: randomUUID(),
      items: [{ productId, quantity: 1 }],
    })
    expect(created.status).toBe(201)
    expect((await request('GET', `/orders/${created.body.id}`, 'north')).status).toBe(200)
    expect((await request('GET', `/orders/${created.body.id}`, 'south')).status).toBe(404)
  })

  it('preserves historical unassigned customer payments under the recorded order branch', async () => {
    const own = await historicalOrder(branchId, 'history-north')
    const foreign = await historicalOrder(otherBranchId, 'history-south')
    expect((await request('GET', `/payments/orders/${own.id}`, 'north')).status).toBe(200)
    expect((await request('GET', `/payments/orders/${foreign.id}`, 'north')).status).toBe(404)
    const list = await request<ListResult>(
      'GET',
      `/payments?search=OPT-${fixture}-history&limit=100`,
      'north',
    )
    expect(list.status).toBe(200)
    expect(list.body.data.map(({ id }) => id)).toEqual([own.id])
    const payment = await request<Created>('POST', '/payments', 'north', {
      orderId: own.id,
      amount: '4.00',
      method: 'Cash',
      paymentDate: '2020-10-01',
      requestKey: randomUUID(),
    })
    expect(payment.status).toBe(201)
    expect(
      (
        await request('POST', '/payments', 'north', {
          orderId: foreign.id,
          amount: '4.00',
          method: 'Cash',
        })
      ).status,
    ).toBe(403)
    const foreignPayment = await request<Created>('POST', '/payments', 'south', {
      orderId: foreign.id,
      amount: '5.00',
      method: 'Cash',
      paymentDate: '2020-10-01',
      requestKey: randomUUID(),
    })
    expect(foreignPayment.status).toBe(201)

    for (const report of ['customer-balances', 'customer-payment-history']) {
      const path = `/reports/data?report=${report}&dateFrom=2020-10-01&dateTo=2020-10-01&customerId=${unassignedCustomerId}`
      const scoped = await request<Report>('GET', path, 'north')
      expect(scoped.status).toBe(200)
      expect(scoped.body.rows.some((row) => row.Order === own.number)).toBe(true)
      expect(scoped.body.rows.some((row) => row.Order === foreign.number)).toBe(false)
      const forged = await request<Report>('GET', `${path}&branchId=${otherBranchId}`, 'north')
      expect(forged.status).toBe(200)
      expect(forged.body.rows.some((row) => row.Order === own.number)).toBe(true)
      expect(forged.body.rows.some((row) => row.Order === foreign.number)).toBe(false)
    }
    const exportCsv = async (actor: string, report: string, selectedBranch?: string) => {
      const query = new URLSearchParams({
        report,
        dateFrom: '2020-10-01',
        dateTo: '2020-10-01',
        customerId: unassignedCustomerId,
      })
      if (selectedBranch) query.set('branchId', selectedBranch)
      const response = await fetch(`${apiUrl}/api/v1/reports/export?${query.toString()}`, {
        headers: { Cookie: accounts[actor]!.cookie },
      })
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        text: await response.text(),
      }
    }

    for (const report of ['customer-balances', 'customer-payment-history']) {
      const branchExport = await exportCsv('north', report)
      expect(branchExport.status).toBe(200)
      expect(branchExport.contentType).toContain('text/csv')
      expect(branchExport.text).toContain(own.number)
      expect(branchExport.text).not.toContain(foreign.number)

      const forgedBranchExport = await exportCsv('north', report, otherBranchId)
      expect(forgedBranchExport.status).toBe(200)
      expect(forgedBranchExport.text).toContain(own.number)
      expect(forgedBranchExport.text).not.toContain(foreign.number)

      const administratorAllBranches = await exportCsv('admin', report)
      expect(administratorAllBranches.status).toBe(200)
      expect(administratorAllBranches.text).toContain(own.number)
      expect(administratorAllBranches.text).toContain(foreign.number)

      const administratorSelectedBranch = await exportCsv('admin', report, branchId)
      expect(administratorSelectedBranch.status).toBe(200)
      expect(administratorSelectedBranch.text).toContain(own.number)
      expect(administratorSelectedBranch.text).not.toContain(foreign.number)
    }

    const admin = await request<Report>(
      'GET',
      `/reports/data?report=customer-balances&dateFrom=2020-10-01&dateTo=2020-10-01&customerId=${unassignedCustomerId}`,
      'admin',
    )
    expect(admin.status).toBe(200)
    expect(admin.body.rows.map((row) => row.Order)).toEqual(
      expect.arrayContaining([own.number, foreign.number]),
    )
  })
})
