import { randomUUID } from 'node:crypto'
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
import { paymentProofForm } from './financial-proof-fixture.js'

const fixture = randomUUID().slice(0, 8)
const staffPermissions = [
  'customers.read',
  'products.read',
  'inventory.read',
  'orders.read',
  'payments.read',
  'deliveries.read',
  'sales.read',
  'orders.create',
  'payments.create',
]
const cookies: Record<string, string> = {}
const ownedProofKeys = new Set<string>()
let server: Server
let apiUrl: string
let branchA: string
let branchB: string
let customerA: string
let customerB: string
let productId: string
let inventoryA: string
let inventoryB: string
let orderA: string
let orderB: string
let orderAOpen: string
let orderItemB: string
let paymentA: string
let paymentB: string
let deliveryA: string
let deliveryB: string
let employeeA: string
let employeeB: string
let vehicleA: string
let vehicleB: string
let proofA: string
let proofB: string
let staffAUserId: string

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=',
  'base64',
)

async function insertId(sql: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(sql, values)
  const id = result.rows[0]?.id
  if (!id) throw new Error('The Staff authorization fixture could not be created.')
  return id
}

async function createAccount(
  label: string,
  branchId: string | null,
  grants: string[],
  systemAdministrator = false,
) {
  const roleId = systemAdministrator
    ? await insertId(
        `insert into roles(name,is_system) values('Administrator',1)
         on conflict(name) do update set is_system=1 returning id`,
        [],
      )
    : await insertId('insert into roles(name) values($1) returning id', [
        `Staff authorization ${label} ${fixture}`,
      ])
  for (const key of grants) {
    await pool.query(
      'insert into role_permissions(role_id, permission_key) values($1, $2) on conflict do nothing',
      [roleId, key],
    )
  }
  const userId = await insertId(
    `insert into users(name,email,password_hash,role_id,branch_id,status,is_cross_branch)
     values($1,$2,'unused-test-hash',$3,$4,'Active',$5) returning id`,
    [
      `Staff authorization ${label}`,
      `staff-auth-${label}-${fixture}@example.invalid`,
      roleId,
      branchId,
      systemAdministrator ? 1 : 0,
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

async function request<T = unknown>(
  method: string,
  path: string,
  account: string,
  body?: Record<string, unknown>,
) {
  const response = await fetch(`${apiUrl}/api/v1${path}`, {
    method,
    headers: {
      Cookie: cookies[account] ?? '',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const raw = await response.text()
  let parsed: T
  try {
    parsed = JSON.parse(raw) as T
  } catch {
    throw new Error(`${method} ${path} returned HTTP ${response.status}: ${raw.slice(0, 120)}`)
  }
  return { status: response.status, body: parsed }
}

async function uploadPaymentProof(account: string, paymentId: string) {
  const response = await fetch(
    `${apiUrl}/api/v1/attachments?entityType=payment&entityId=${paymentId}`,
    {
      method: 'POST',
      headers: {
        Cookie: cookies[account] ?? '',
        'Content-Type': 'image/png',
        'x-file-name': 'staff-proof.png',
      },
      body: new Uint8Array(png),
    },
  )
  const body = (await response.json()) as { id: string; objectKey?: string }
  if (response.status !== 201) {
    throw new Error(`Payment proof fixture upload returned HTTP ${response.status}.`)
  }
  if (typeof body.objectKey === 'string') ownedProofKeys.add(body.objectKey)
  const key = await pool.query<{ object_key: string }>(
    'select object_key from attachments where id=$1',
    [body.id],
  )
  if (key.rows[0]) ownedProofKeys.add(key.rows[0].object_key)
  return body.id
}

async function requestProofContent(account: string, proofId: string) {
  const response = await fetch(`${apiUrl}/api/v1/attachments/${proofId}/content`, {
    headers: { Cookie: cookies[account] ?? '' },
  })
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) }
}

beforeAll(async () => {
  expect(env.nodeEnv).toBe('test')
  expect(env.r2.enabled).toBe(false)
  expect(new URL(env.databaseUrl).pathname.slice(1)).toMatch(
    /^cbms_(?:test|integration_[a-z0-9_]+)$/,
  )

  for (const key of new Set([
    ...staffPermissions,
    'reports.view',
    'reports.export',
    'employees.read',
    'vehicles.read',
    'payroll.read',
    'deliveries.create',
    'payments.refund.request',
  ])) {
    await pool.query(
      'insert into permissions(key, description) values($1,$1) on conflict(key) do nothing',
      [key],
    )
  }

  branchA = await insertId('insert into branches(name,code) values($1,$2) returning id', [
    `Staff A ${fixture}`,
    `sa-${fixture}`,
  ])
  branchB = await insertId('insert into branches(name,code) values($1,$2) returning id', [
    `Staff B ${fixture}`,
    `sb-${fixture}`,
  ])
  customerA = await insertId('insert into customers(name,branch_id) values($1,$2) returning id', [
    `Staff customer A ${fixture}`,
    branchA,
  ])
  customerB = await insertId('insert into customers(name,branch_id) values($1,$2) returning id', [
    `Staff customer B ${fixture}`,
    branchB,
  ])
  productId = await insertId(
    `insert into products(name,sku,category,unit,unit_price)
     values($1,$2,'Materials','piece','10.00') returning id`,
    [`Staff product ${fixture}`, `STAFF-${fixture}`],
  )
  inventoryA = await insertId(
    'insert into inventory(product_id,branch_id,quantity) values($1,$2,10) returning id',
    [productId, branchA],
  )
  inventoryB = await insertId(
    'insert into inventory(product_id,branch_id,quantity) values($1,$2,90) returning id',
    [productId, branchB],
  )

  staffAUserId = await createAccount('staff-a', branchA, staffPermissions)
  await createAccount('staff-b', branchB, staffPermissions)
  // Manager grants include the same scoped business views plus report access.
  await createAccount('manager-a', branchA, [
    ...staffPermissions,
    'reports.view',
    'reports.export',
    'employees.read',
    'vehicles.read',
    'payroll.read',
    'deliveries.create',
    'payments.refund.request',
  ])
  const administratorPermissions = [
    ...staffPermissions,
    'reports.view',
    'reports.export',
    'employees.read',
    'vehicles.read',
    'payroll.read',
  ]
  for (const key of administratorPermissions) {
    await pool.query(
      'insert into permissions(key, description) values($1,$1) on conflict(key) do nothing',
      [key],
    )
  }
  await createAccount('admin', null, administratorPermissions, true)

  async function createOrder(label: string, branchId: string, customerId: string, amount: string) {
    const id = await insertId(
      `insert into orders(order_number,customer_id,branch_id,total_amount,status,created_by)
       values($1,$2,$3,$4,'Processing',$5) returning id`,
      [`STAFF-${fixture}-${label}`, customerId, branchId, amount, staffAUserId],
    )
    await pool.query(
      `insert into order_items(order_id,product_id,quantity,unit_price,line_total)
       values($1,$2,1,$3,$3)`,
      [id, productId, amount],
    )
    return id
  }
  orderA = await createOrder('A', branchA, customerA, '12.34')
  orderB = await createOrder('B', branchB, customerB, '98.76')
  await createOrder('B-pending', branchB, customerB, '7.00')
  const branchBOrderItem = await pool.query<{ id: string }>(
    'select id from order_items where order_id=$1',
    [orderB],
  )
  orderItemB = branchBOrderItem.rows[0]!.id
  await pool.query('update inventory set reorder_level=15 where id=$1', [inventoryA])
  paymentA = await insertId(
    `insert into payments(reference,order_id,method,amount,status,recorded_by)
     values($1,$2,'Cash','12.34','Paid',$3) returning id`,
    [`STAFF-PAY-A-${fixture}`, orderA, staffAUserId],
  )
  paymentB = await insertId(
    `insert into payments(reference,order_id,method,amount,status,recorded_by)
     values($1,$2,'Cash','98.76','Paid',$3) returning id`,
    [`STAFF-PAY-B-${fixture}`, orderB, staffAUserId],
  )
  deliveryA = await insertId(
    `insert into deliveries(reference,order_id,destination,status)
     values($1,$2,'Branch A site','In Transit') returning id`,
    [`STAFF-DEL-A-${fixture}`, orderA],
  )
  deliveryB = await insertId(
    `insert into deliveries(reference,order_id,destination,status)
     values($1,$2,'Branch B site','In Transit') returning id`,
    [`STAFF-DEL-B-${fixture}`, orderB],
  )
  employeeA = await insertId(
    `insert into employees(employee_number,name,position,branch_id,status,is_driver)
     values($1,$2,'Staff',$3,'Active',0) returning id`,
    [`STA-${fixture}`, `Staff employee A ${fixture}`, branchA],
  )
  employeeB = await insertId(
    `insert into employees(employee_number,name,position,branch_id,status,is_driver)
     values($1,$2,'Staff',$3,'Active',0) returning id`,
    [`STB-${fixture}`, `Staff employee B ${fixture}`, branchB],
  )
  vehicleA = await insertId(
    `insert into vehicles(name,plate_number,vehicle_type,status,branch_id)
     values($1,$2,'Pickup','Available',$3) returning id`,
    [`Staff vehicle A ${fixture}`, `STA-${fixture}`, branchA],
  )
  vehicleB = await insertId(
    `insert into vehicles(name,plate_number,vehicle_type,status,branch_id)
     values($1,$2,'Pickup','Available',$3) returning id`,
    [`Staff vehicle B ${fixture}`, `STB-${fixture}`, branchB],
  )

  // Add completed orders for HTTP report assertions while keeping dashboard totals distinct.
  await pool.query("update orders set status='Completed' where id=$1", [orderA])
  await pool.query("update orders set status='Completed' where id=$1", [orderB])

  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('The Staff test server did not start.')
  apiUrl = `http://127.0.0.1:${address.port}`

  proofA = await uploadPaymentProof('staff-a', paymentA)
  proofB = await uploadPaymentProof('staff-b', paymentB)
})

afterAll(async () => {
  try {
    for (const key of ownedProofKeys) {
      const { removeStoredProof } = await import('@/features/attachments/attachment.storage.js')
      await removeStoredProof(key)
    }
    await pool.query('delete from attachments where id=any($1::uuid[])', [
      [proofA, proofB].filter(Boolean),
    ])
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await pool.end()
  }
})

describe('Staff HTTP authorization and branch isolation', () => {
  it('allows same-branch customer, product, inventory, order, payment and delivery reads', async () => {
    const [customers, products, inventory, order, payment, delivery] = await Promise.all([
      request<{ data: { id: string; Customer: string }[] }>(
        'GET',
        `/customers?search=${encodeURIComponent(fixture)}`,
        'staff-a',
      ),
      request<{ data: { id: string; Product: string }[] }>(
        'GET',
        `/products?search=${encodeURIComponent(fixture)}`,
        'staff-a',
      ),
      request<{ data: { id: string; branchId: string }[] }>(
        'GET',
        `/inventory?search=${encodeURIComponent(fixture)}`,
        'staff-a',
      ),
      request<{ id: string }>('GET', `/orders/${orderA}`, 'staff-a'),
      request('GET', `/payments/orders/${orderA}`, 'staff-a'),
      request('GET', `/deliveries/${deliveryA}`, 'staff-a'),
    ])
    expect(customers.status).toBe(200)
    expect(customers.body.data.map((row) => row.id)).toContain(customerA)
    expect(products.status).toBe(200)
    expect(products.body.data.map((row) => row.id)).toContain(productId)
    expect(inventory.status).toBe(200)
    expect(inventory.body.data.map((row) => row.id)).toEqual([inventoryA])
    expect(order.status).toBe(200)
    expect(payment.status).toBe(200)
    expect(delivery.status).toBe(200)

    const branchBReads = await Promise.all([
      request<{ data: { id: string }[] }>(
        'GET',
        `/customers?search=${encodeURIComponent(fixture)}`,
        'staff-b',
      ),
      request<{ data: { id: string }[] }>(
        'GET',
        `/inventory?search=${encodeURIComponent(fixture)}`,
        'staff-b',
      ),
      request('GET', `/orders/${orderB}`, 'staff-b'),
      request('GET', `/payments/orders/${orderB}`, 'staff-b'),
      request('GET', `/deliveries/${deliveryB}`, 'staff-b'),
    ])
    expect(branchBReads.map((result) => result.status)).toEqual([200, 200, 200, 200, 200])
    expect(branchBReads[0]?.body.data.map((row) => row.id)).toContain(customerB)
    expect(branchBReads[1]?.body.data.map((row) => row.id)).toEqual([inventoryB])
  })

  it('denies foreign branch records and forged branch filters or IDs', async () => {
    const [customer, filteredCustomers, inventory, order, payment, delivery] = await Promise.all([
      request('GET', `/customers/${customerB}`, 'staff-a'),
      request('GET', `/customers?branchId=${branchB}`, 'staff-a'),
      request('GET', `/inventory/${inventoryB}`, 'staff-a'),
      request('GET', `/orders/${orderB}`, 'staff-a'),
      request('GET', `/payments/orders/${orderB}`, 'staff-a'),
      request('GET', `/deliveries/${deliveryB}`, 'staff-a'),
    ])
    expect(customer.status).toBe(404)
    expect(filteredCustomers.status).toBe(403)
    expect(inventory.status).toBe(404)
    expect(order.status).toBe(404)
    expect(payment.status).toBe(404)
    expect(delivery.status).toBe(404)

    const forgedBranch = await request('GET', `/orders?branchId=${branchB}`, 'staff-a')
    expect(forgedBranch.status).toBe(403)
  })

  it('rejects forged related customer IDs and branch IDs during Staff order creation', async () => {
    const foreignCustomer = await request<{ error: { code: string } }>(
      'POST',
      '/orders',
      'staff-a',
      { customerId: customerB, branchId: branchA, items: [{ productId, quantity: 1 }] },
    )
    expect(foreignCustomer.status).toBe(404)
    expect(foreignCustomer.body.error.code).toBe('CUSTOMER_NOT_FOUND')

    const foreignBranch = await request<{ error: { code: string } }>('POST', '/orders', 'staff-a', {
      customerId: customerA,
      branchId: branchB,
      items: [{ productId, quantity: 1 }],
    })
    expect(foreignBranch.status).toBe(403)
    expect(foreignBranch.body.error.code).toBe('BRANCH_FORBIDDEN')
    const persisted = await pool.query<{ count: string }>(
      'select count(*)::text as count from orders where order_number like $1',
      [`STAFF-${fixture}-%`],
    )
    expect(persisted.rows[0]?.count).toBe('3')
  })

  it('scopes dashboard totals to the authenticated branch despite forged query filters', async () => {
    const [summaryA, summaryB, forged, summaryManager] = await Promise.all([
      request<{
        stats: { salesTotal: string; stockAlerts: number }
        operations: { customerBalances: { outstandingBalance: string; outstandingOrders: number } }
        branchSales: { name: string; total: string }[]
        recentOrders: { Order: string }[]
      }>('GET', '/dashboard/summary', 'staff-a'),
      request<{
        stats: { salesTotal: string; stockAlerts: number }
        operations: { customerBalances: { outstandingBalance: string; outstandingOrders: number } }
        branchSales: { name: string; total: string }[]
        recentOrders: { Order: string }[]
      }>('GET', '/dashboard/summary', 'staff-b'),
      request<{ stats: { salesTotal: string }; branchSales: { name: string }[] }>(
        'GET',
        `/dashboard/summary?branchId=${branchB}`,
        'staff-a',
      ),
      request<{ stats: { salesTotal: string }; branchSales: { name: string }[] }>(
        'GET',
        '/dashboard/summary',
        'manager-a',
      ),
    ])
    expect(summaryA.status).toBe(200)
    expect(summaryA.body.stats.salesTotal).toBe('12.34')
    expect(summaryA.body.stats.stockAlerts).toBe(1)
    expect(summaryA.body.branchSales).toEqual([{ name: `Staff A ${fixture}`, total: '12.34' }])
    expect(summaryA.body.recentOrders.map((row) => row.Order)).toEqual([`STAFF-${fixture}-A`])
    expect(summaryA.body.operations.customerBalances).toEqual({
      outstandingBalance: '0.00',
      outstandingOrders: 0,
    })
    expect(summaryB.body.stats.salesTotal).toBe('105.76')
    expect(summaryB.body.stats.stockAlerts).toBe(0)
    expect(summaryB.body.branchSales).toEqual([{ name: `Staff B ${fixture}`, total: '105.76' }])
    expect(summaryB.body.operations.customerBalances).toEqual({
      outstandingBalance: '7.00',
      outstandingOrders: 1,
    })
    expect(summaryB.body.recentOrders.map((row) => row.Order)).toEqual([
      `STAFF-${fixture}-B-pending`,
      `STAFF-${fixture}-B`,
    ])
    expect(forged.body).toEqual(summaryA.body)
    expect(summaryManager.body.stats.salesTotal).toBe('12.34')
    expect(summaryManager.body.branchSales).toEqual(summaryA.body.branchSales)
  })

  it('denies modules and writes absent from the Staff grant set', async () => {
    const deniedPaths = [
      `/employees/${employeeA}`,
      `/employees/${employeeB}`,
      `/payroll/entries`,
      `/vehicles?search=${encodeURIComponent(fixture)}`,
      `/vehicles/${vehicleA}`,
      `/reports/options`,
      `/reports/data?report=sales-by-branch&dateFrom=2026-01-01&dateTo=2026-12-31&branchId=${branchB}`,
      `/reports/export?report=sales-by-branch&dateFrom=2026-01-01&dateTo=2026-12-31&branchId=${branchB}`,
    ]
    for (const path of deniedPaths) {
      const response = await request<{ error: { code: string } }>('GET', path, 'staff-a')
      expect(response.status, path).toBe(403)
      expect(response.body.error.code, path).toBe('FORBIDDEN')
    }

    const inventoryWrite = await request<{ error: { code: string } }>(
      'POST',
      '/inventory/adjustments',
      'staff-a',
      { productId, branchId: branchB, quantityDelta: '1', note: 'scope test' },
    )
    expect(inventoryWrite.status).toBe(403)
  })

  it('allows same-branch private proof reads and denies a known foreign proof ID', async () => {
    const [
      ownMetadata,
      ownContent,
      branchBMetadata,
      branchBContent,
      foreignMetadata,
      foreignContent,
    ] = await Promise.all([
      request<{ items: { id: string }[] }>(
        'GET',
        `/attachments?entityType=payment&entityId=${paymentA}`,
        'staff-a',
      ),
      requestProofContent('staff-a', proofA),
      request<{ items: { id: string }[] }>(
        'GET',
        `/attachments?entityType=payment&entityId=${paymentB}`,
        'staff-b',
      ),
      requestProofContent('staff-b', proofB),
      request('GET', `/attachments?entityType=payment&entityId=${paymentB}`, 'staff-a'),
      requestProofContent('staff-a', proofB),
    ])
    expect(ownMetadata.status).toBe(200)
    expect(ownMetadata.body.items.map((item) => item.id)).toContain(proofA)
    expect(ownContent.status).toBe(200)
    expect(ownContent.bytes).toEqual(png)
    expect(JSON.stringify(ownMetadata.body)).not.toMatch(/(?:local|r2)\//)
    expect(branchBMetadata.status).toBe(200)
    expect(branchBMetadata.body.items.map((item) => item.id)).toContain(proofB)
    expect(branchBContent.status).toBe(200)
    expect(branchBContent.bytes).toEqual(png)
    expect(foreignMetadata.status).toBe(404)
    expect(foreignContent.status).toBe(404)
  })

  it('keeps Manager records and nested relationships inside its branch', async () => {
    const foreignRecords = await Promise.all([
      request('GET', `/customers/${customerB}`, 'manager-a'),
      request('GET', `/inventory/${inventoryB}`, 'manager-a'),
      request('GET', `/orders/${orderB}`, 'manager-a'),
      request('GET', `/payments/orders/${orderB}`, 'manager-a'),
      request('GET', `/deliveries/${deliveryB}`, 'manager-a'),
      request('GET', `/employees/${employeeB}`, 'manager-a'),
      request('GET', `/vehicles/${vehicleB}`, 'manager-a'),
    ])
    expect(foreignRecords.map((result) => result.status)).toEqual([
      404, 404, 404, 404, 404, 404, 404,
    ])

    const foreignCustomerOrder = await request<{ error: { code: string } }>(
      'POST',
      '/orders',
      'manager-a',
      { customerId: customerB, branchId: branchA, items: [{ productId, quantity: 1 }] },
    )
    expect(foreignCustomerOrder.status).toBe(404)
    expect(foreignCustomerOrder.body.error.code).toBe('CUSTOMER_NOT_FOUND')

    const foreignPaymentRefund = await request<{ error: { code: string } }>(
      'POST',
      `/orders/${orderA}/refunds`,
      'manager-a',
      {
        requestKey: randomUUID(),
        paymentId: paymentB,
        amount: '1.00',
        method: 'Cash',
        reason: 'Relationship scope verification',
      },
    )
    expect(foreignPaymentRefund.status).toBe(404)
    expect(foreignPaymentRefund.body.error.code).toBe('PAYMENT_NOT_FOUND')

    orderAOpen = await insertId(
      `insert into orders(order_number,customer_id,branch_id,total_amount,status,created_by)
       values($1,$2,$3,'10.00','Processing',$4) returning id`,
      [`STAFF-${fixture}-A-open`, customerA, branchA, staffAUserId],
    )
    await pool.query(
      `insert into order_items(order_id,product_id,quantity,unit_price,line_total)
       values($1,$2,1,'10.00','10.00')`,
      [orderAOpen, productId],
    )
    const foreignOrderItemDelivery = await request<{ error: { code: string } }>(
      'POST',
      '/deliveries',
      'manager-a',
      {
        orderId: orderAOpen,
        destination: 'Branch A test site',
        items: [{ orderItemId: orderItemB, quantity: '1' }],
      },
    )
    expect(foreignOrderItemDelivery.status).toBe(404)
    expect(foreignOrderItemDelivery.body.error.code).toBe('ORDER_ITEM_NOT_FOUND')
    const leakedDelivery = await pool.query<{ count: string }>(
      'select count(*)::text as count from deliveries where order_id=$1',
      [orderAOpen],
    )
    expect(leakedDelivery.rows[0]?.count).toBe('0')

    const managerProof = await requestProofContent('manager-a', proofA)
    const foreignProof = await requestProofContent('manager-a', proofB)
    expect(managerProof.status).toBe(200)
    expect(foreignProof.status).toBe(404)
  })

  it('preserves system Administrator cross-branch reads, aggregates, reports and validation', async () => {
    const [customer, inventory, order, payment, delivery, employee, vehicle, proof] =
      await Promise.all([
        request('GET', `/customers/${customerB}`, 'admin'),
        request('GET', `/inventory/${inventoryB}`, 'admin'),
        request('GET', `/orders/${orderB}`, 'admin'),
        request('GET', `/payments/orders/${orderB}`, 'admin'),
        request('GET', `/deliveries/${deliveryB}`, 'admin'),
        request('GET', `/employees/${employeeB}`, 'admin'),
        request('GET', `/vehicles/${vehicleB}`, 'admin'),
        requestProofContent('admin', proofB),
      ])
    expect(
      [customer, inventory, order, payment, delivery, employee, vehicle].map((row) => row.status),
    ).toEqual([200, 200, 200, 200, 200, 200, 200])
    expect(proof.status).toBe(200)

    const allBranches = await request<{
      stats: { salesTotal: string }
      branchSales: { name: string; total: string }[]
    }>('GET', '/dashboard/summary', 'admin')
    expect(allBranches.status).toBe(200)
    // The dashboard deliberately returns only the top four branches. Other test
    // files share this disposable DB, so these fixtures need not appear in that chart.
    expect(Number(allBranches.body.stats.salesTotal)).toBeGreaterThanOrEqual(128.1)
    expect(allBranches.body.branchSales.length).toBeGreaterThanOrEqual(2)
    expect(allBranches.body.branchSales.length).toBeLessThanOrEqual(4)
    const chartTotals = allBranches.body.branchSales.map((row) => Number(row.total))
    expect(chartTotals).toEqual([...chartTotals].sort((left, right) => right - left))

    const year = new Date().getUTCFullYear()
    const query = new URLSearchParams({
      report: 'sales-by-branch',
      dateFrom: `${year}-01-01`,
      dateTo: `${year}-12-31`,
    })
    const report = await request<{ rows: Record<string, string>[] }>(
      'GET',
      `/reports/data?${query}`,
      'admin',
    )
    expect(report.status).toBe(200)
    expect(report.body.rows.map((row) => row.Branch)).toEqual(
      expect.arrayContaining([`Staff A ${fixture}`, `Staff B ${fixture}`]),
    )
    const exported = await fetch(`${apiUrl}/api/v1/reports/export?${query}`, {
      headers: { Cookie: cookies.admin ?? '' },
    })
    const csv = await exported.text()
    expect(exported.status).toBe(200)
    expect(exported.headers.get('content-disposition')).toContain(
      'materials-supply-operations-finance-sales-by-branch',
    )
    expect(csv).toContain(`Staff A ${fixture}`)
    expect(csv).toContain(`Staff B ${fixture}`)

    const invalidCustomer = await request<{ error: { code: string } }>('POST', '/orders', 'admin', {
      customerId: randomUUID(),
      branchId: branchA,
      items: [{ productId, quantity: 1 }],
    })
    expect(invalidCustomer.status).toBe(404)
    expect(invalidCustomer.body.error.code).toBe('CUSTOMER_NOT_FOUND')
  })

  it('keeps report filters branch-scoped for Manager and denies Staff report access', async () => {
    const year = new Date().getUTCFullYear()
    const query = new URLSearchParams({
      report: 'sales-by-branch',
      dateFrom: `${year}-01-01`,
      dateTo: `${year}-12-31`,
      branchId: branchB,
    })
    const report = await request<{ rows: Record<string, string>[] }>(
      'GET',
      `/reports/data?${query}`,
      'manager-a',
    )
    expect(report.status).toBe(200)
    expect(report.body.rows.map((row) => row.Branch)).toEqual([`Staff A ${fixture}`])
    expect(report.body.rows[0]?.['Sales (PHP)']).toBe('12.34')

    const exported = await fetch(`${apiUrl}/api/v1/reports/export?${query}`, {
      headers: { Cookie: cookies['manager-a'] ?? '' },
    })
    const csv = await exported.text()
    expect(exported.status).toBe(200)
    expect(csv).toContain(`Staff A ${fixture}`)
    expect(csv).not.toContain(`Staff B ${fixture}`)
    expect(csv).toContain('12.34')
    expect(csv).not.toContain('98.76')

    const staffReport = await request<{ error: { code: string } }>(
      'GET',
      `/reports/data?${query}`,
      'staff-a',
    )
    expect(staffReport.status).toBe(403)
    expect(staffReport.body.error.code).toBe('FORBIDDEN')
  })

  it('completes an authorized same-branch Staff order and payment workflow', async () => {
    const order = await request<{ id: string; totalAmount: string }>('POST', '/orders', 'staff-a', {
      customerId: customerA,
      branchId: branchA,
      items: [{ productId, quantity: 1 }],
    })
    expect(order.status).toBe(201)
    expect(order.body.totalAmount).toBe('10.00')

    const paymentResponse = await fetch(`${apiUrl}/api/v1/payments/with-proof`, {
      method: 'POST',
      headers: { Cookie: cookies['staff-a'] ?? '' },
      body: paymentProofForm({ orderId: order.body.id, amount: '5.00', method: 'Cash' }),
    })
    expect(paymentResponse.status).toBe(201)
    const proofKeys = await pool.query<{ object_key: string }>(
      `select object_key from attachments where entity_type='payment' and entity_id in
       (select id from payments where order_id=$1)`,
      [order.body.id],
    )
    for (const proof of proofKeys.rows) ownedProofKeys.add(proof.object_key)

    const detail = await request<{ id: string }>('GET', `/orders/${order.body.id}`, 'staff-a')
    expect(detail.status).toBe(200)
    expect(detail.body.id).toBe(order.body.id)
  })
})
