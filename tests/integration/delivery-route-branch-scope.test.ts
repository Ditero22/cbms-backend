import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '@/app.js'
import { removeStoredProof } from '@/features/attachments/attachment.storage.js'
import { pool } from '@/database/client.js'
import {
  createSessionToken,
  hashSessionToken,
  sessionCookieName,
} from '@/shared/security/session.js'

type ApiError = { error: { code: string; message: string } }
type Order = { id: string; items: { id: string }[] }
type DeliveryOptions = { id: string; orderNumber: string; branchId: string }[]
type Delivery = { id: string; reference: string; status: string }
type DeliveryList = { data: { id: string }[]; total: number }

const fixture = randomUUID().slice(0, 8)
const cookies: Record<string, string> = {}
let server: Server
let apiUrl: string
let branchId: string
let otherBranchId: string
let customerId: string
let otherCustomerId: string
let productId: string
let reportNorthUserId: string
let reportSouthUserId: string

async function insertId(query: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(query, values)
  const id = result.rows[0]?.id
  if (!id) throw new Error('The delivery route fixture could not be created.')
  return id
}

async function createAccount(
  label: string,
  assignedBranchId: string | null,
  permissions: string[],
  system = false,
) {
  const roleId = system
    ? await insertId(
        `insert into roles (name,is_system) values ('Administrator',1)
         on conflict (name) do update set is_system=1 returning id`,
        [],
      )
    : await insertId('insert into roles (name,is_system) values ($1,0) returning id', [
        `Delivery route ${label} ${fixture}`,
      ])
  for (const permission of permissions) {
    await pool.query(
      `insert into role_permissions (role_id, permission_key) values ($1, $2)
       on conflict do nothing`,
      [roleId, permission],
    )
  }
  const userId = await insertId(
    `insert into users (email, name, password_hash, role_id, branch_id, is_cross_branch, status)
     values ($1, $2, 'unused-test-hash', $3, $4, $5, 'Active') returning id`,
    [
      `delivery-route-${label}-${fixture}@example.invalid`,
      `Delivery route ${label}`,
      roleId,
      assignedBranchId,
      system ? 1 : 0,
    ],
  )
  const token = createSessionToken()
  await pool.query(
    `insert into user_sessions (user_id, token_hash, expires_at)
     values ($1, $2, now() + interval '1 hour')`,
    [userId, hashSessionToken(token)],
  )
  cookies[label] = `${sessionCookieName}=${token}`
  return userId
}

async function request<T>(
  method: string,
  path: string,
  account?: string,
  body?: Record<string, unknown>,
) {
  const response = await fetch(`${apiUrl}/api/v1${path}`, {
    method,
    headers: {
      ...(account ? { Cookie: cookies[account] ?? '' } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const rawBody = await response.text()
  let parsed: T
  try {
    parsed = JSON.parse(rawBody) as T
  } catch {
    throw new Error(`${method} ${path} returned HTTP ${response.status}: ${rawBody.slice(0, 120)}`)
  }
  return { status: response.status, body: parsed }
}

async function createOrder(
  account: string,
  requestedBranchId: string,
  requestedCustomerId: string,
) {
  const created = await request<{ id: string }>('POST', '/orders', account, {
    customerId: requestedCustomerId,
    branchId: requestedBranchId,
    items: [{ productId, quantity: 2 }],
  })
  expect(created.status).toBe(201)
  const detail = await request<Order>('GET', `/orders/${created.body.id}`, account)
  expect(detail.status).toBe(200)
  const orderItemId = detail.body.items[0]?.id
  if (!orderItemId) throw new Error('The delivery route order item is missing.')
  return { id: created.body.id, orderItemId }
}

async function createDelivery(account: string, orderId: string, orderItemId: string) {
  return request<Delivery>('POST', '/deliveries', account, {
    orderId,
    destination: 'Branch-specific integration site',
    items: [{ orderItemId, quantity: '1' }],
  })
}

async function createCompletedReportOrder(
  label: string,
  branch: string,
  customer: string,
  recordedBy: string,
  amount: string,
) {
  const orderNumber = `DR-REPORT-${fixture}-${label}`
  const orderId = await insertId(
    `insert into orders (order_number, customer_id, branch_id, total_amount, status, created_by)
     values ($1, $2, $3, $4, 'Completed', $5) returning id`,
    [orderNumber, customer, branch, amount, recordedBy],
  )
  await pool.query(
    `insert into order_items (order_id, product_id, quantity, unit_price, line_total)
     values ($1, $2, '2', '10.00', $3)`,
    [orderId, productId, amount],
  )
  await pool.query(
    `insert into payments (reference, order_id, method, amount, status, recorded_by)
     values ($1, $2, 'Cash', $3, 'Paid', $4)`,
    [`${orderNumber}-PAY`, orderId, amount, recordedBy],
  )
}

beforeAll(async () => {
  const grants = [
    'sales.read',
    'orders.create',
    'deliveries.create',
    'deliveries.update',
    'deliveries.read',
  ]
  for (const permission of [...grants, 'reports.view', 'reports.export']) {
    await pool.query(
      'insert into permissions (key, description) values ($1, $2) on conflict (key) do nothing',
      [permission, `Delivery route test ${permission}`],
    )
  }

  branchId = await insertId('insert into branches (name, code) values ($1, $2) returning id', [
    `Delivery route North ${fixture}`,
    `dr-n-${fixture}`,
  ])
  otherBranchId = await insertId('insert into branches (name, code) values ($1, $2) returning id', [
    `Delivery route South ${fixture}`,
    `dr-s-${fixture}`,
  ])
  customerId = await insertId(
    'insert into customers (name, branch_id) values ($1, $2) returning id',
    [`Delivery route customer ${fixture}`, branchId],
  )
  otherCustomerId = await insertId(
    'insert into customers (name, branch_id) values ($1, $2) returning id',
    [`Delivery route other customer ${fixture}`, otherBranchId],
  )
  productId = await insertId(
    `insert into products (name, sku, category, unit, unit_price)
     values ($1, $2, 'Materials', 'piece', '10.00') returning id`,
    [`Delivery route product ${fixture}`, `DR-${fixture}`],
  )
  await pool.query(
    'insert into inventory (product_id, branch_id, quantity) values ($1, $2, $3), ($1, $4, $3)',
    [productId, branchId, '20.000', otherBranchId],
  )

  await createAccount('north', branchId, grants)
  await createAccount('south', otherBranchId, grants)
  await createAccount('admin', null, grants, true)
  await createAccount('viewer', branchId, ['sales.read'])
  await createAccount('unassigned', null, ['deliveries.create', 'deliveries.update'])
  reportNorthUserId = await createAccount('report-north', branchId, [
    'sales.read',
    'reports.view',
    'reports.export',
  ])
  reportSouthUserId = await createAccount('report-south', otherBranchId, [
    'sales.read',
    'reports.view',
    'reports.export',
  ])
  await createAccount('report-viewer', branchId, ['sales.read', 'reports.view'])

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('The delivery route test server did not start.')
  apiUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
  await pool.end()
})

describe('delivery route permissions and branch scope', () => {
  it('limits delivery options to the assigned branch and requires a branch assignment', async () => {
    const northOrder = await createOrder('north', branchId, customerId)
    const southOrder = await createOrder('south', otherBranchId, otherCustomerId)

    const northOptions = await request<DeliveryOptions>(
      'GET',
      `/deliveries/options?branchId=${otherBranchId}`,
      'north',
    )
    const southOptions = await request<DeliveryOptions>('GET', '/deliveries/options', 'south')
    const adminOptions = await request<DeliveryOptions>('GET', '/deliveries/options', 'admin')
    expect(northOptions.status).toBe(200)
    expect(northOptions.body.map((order) => order.id)).toEqual([northOrder.id])
    expect(northOptions.body.map((order) => order.branchId)).toEqual([branchId])
    expect(southOptions.status).toBe(200)
    expect(southOptions.body.map((order) => order.id)).toEqual([southOrder.id])
    expect(adminOptions.status).toBe(200)
    expect(adminOptions.body.map((order) => order.id)).toEqual(
      expect.arrayContaining([northOrder.id, southOrder.id]),
    )

    const missingGrant = await request<ApiError>('GET', '/deliveries/options', 'viewer')
    expect(missingGrant.status).toBe(403)
    expect(missingGrant.body.error.code).toBe('FORBIDDEN')

    const missingBranch = await request<ApiError>('GET', '/deliveries/options', 'unassigned')
    expect(missingBranch.status).toBe(403)
    expect(missingBranch.body.error.code).toBe('BRANCH_REQUIRED')
  })

  it('rejects foreign-branch delivery creation and status updates at the HTTP boundary', async () => {
    const northOrder = await createOrder('north', branchId, customerId)
    const southOrder = await createOrder('south', otherBranchId, otherCustomerId)

    const foreignCreate = await createDelivery('north', southOrder.id, southOrder.orderItemId)
    expect(foreignCreate.status).toBe(403)
    expect((foreignCreate.body as ApiError).error.code).toBe('BRANCH_FORBIDDEN')

    const northDelivery = await createDelivery('north', northOrder.id, northOrder.orderItemId)
    const southDelivery = await createDelivery('south', southOrder.id, southOrder.orderItemId)
    expect(northDelivery.status).toBe(201)
    expect(southDelivery.status).toBe(201)

    const northList = await request<DeliveryList>('GET', '/deliveries', 'north')
    const southList = await request<DeliveryList>('GET', '/deliveries', 'south')
    const forgedBranch = await request<ApiError>(
      'GET',
      `/deliveries?branchId=${otherBranchId}`,
      'north',
    )
    const adminList = await request<DeliveryList>('GET', '/deliveries', 'admin')
    const adminNorthList = await request<DeliveryList>(
      'GET',
      `/deliveries?branchId=${branchId}`,
      'admin',
    )
    expect(northList.status).toBe(200)
    expect(northList.body.data.map((delivery) => delivery.id)).toContain(northDelivery.body.id)
    expect(northList.body.data.map((delivery) => delivery.id)).not.toContain(southDelivery.body.id)
    expect(southList.status).toBe(200)
    expect(southList.body.data.map((delivery) => delivery.id)).toContain(southDelivery.body.id)
    expect(southList.body.data.map((delivery) => delivery.id)).not.toContain(northDelivery.body.id)
    expect(forgedBranch.status).toBe(403)
    expect(forgedBranch.body.error.code).toBe('BRANCH_FORBIDDEN')
    expect(adminList.status).toBe(200)
    expect(adminList.body.data.map((delivery) => delivery.id)).toEqual(
      expect.arrayContaining([northDelivery.body.id, southDelivery.body.id]),
    )
    expect(adminNorthList.status).toBe(200)
    expect(adminNorthList.body.data.map((delivery) => delivery.id)).toContain(northDelivery.body.id)
    expect(adminNorthList.body.data.map((delivery) => delivery.id)).not.toContain(
      southDelivery.body.id,
    )

    const foreignUpdate = await request<ApiError>(
      'PATCH',
      `/deliveries/${southDelivery.body.id}/status`,
      'north',
      { status: 'In Transit' },
    )
    expect(foreignUpdate.status).toBe(403)
    expect(foreignUpdate.body.error.code).toBe('BRANCH_FORBIDDEN')

    const missingGrant = await request<ApiError>(
      'PATCH',
      `/deliveries/${northDelivery.body.id}/status`,
      'viewer',
      { status: 'In Transit' },
    )
    expect(missingGrant.status).toBe(403)
    expect(missingGrant.body.error.code).toBe('FORBIDDEN')

    const unassignedUpdate = await request<ApiError>(
      'PATCH',
      `/deliveries/${northDelivery.body.id}/status`,
      'unassigned',
      { status: 'In Transit' },
    )
    expect(unassignedUpdate.status).toBe(403)
    expect(unassignedUpdate.body.error.code).toBe('BRANCH_FORBIDDEN')

    const hiddenForeign = await request<ApiError>(
      'GET',
      `/deliveries/${southDelivery.body.id}`,
      'north',
    )
    expect(hiddenForeign.status).toBe(404)
    expect(hiddenForeign.body.error.code).toBe('DELIVERY_NOT_FOUND')
  })

  it('stores optional delivery proof privately and rejects cross-branch content access', async () => {
    const order = await createOrder('north', branchId, customerId)
    const created = await createDelivery('north', order.id, order.orderItemId)
    expect(created.status).toBe(201)
    const delivery = created.body as { id: string }
    const query = new URLSearchParams({ entityType: 'delivery', entityId: delivery.id })
    const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF')
    const uploaded = await fetch(`${apiUrl}/api/v1/attachments?${query}`, {
      method: 'POST',
      headers: {
        Cookie: cookies.north,
        'Content-Type': 'application/pdf',
        'x-file-name': 'delivery-proof.pdf',
      },
      body: new Blob([pdf], { type: 'application/pdf' }),
    })
    expect(uploaded.status).toBe(201)
    const attachment = (await uploaded.json()) as { id: string }
    try {
      const own = await request<{ items: { id: string }[] }>(
        'GET',
        `/attachments?${query}`,
        'north',
      )
      expect(own.status).toBe(200)
      expect(own.body.items.map((item) => item.id)).toContain(attachment.id)
      expect((await request('GET', `/attachments?${query}`, 'south')).status).toBe(404)
      expect((await request('GET', `/attachments?${query}`, 'admin')).status).toBe(200)
      for (const label of ['north', 'admin']) {
        const response = await fetch(`${apiUrl}/api/v1/attachments/${attachment.id}/content`, {
          headers: { Cookie: cookies[label] },
        })
        expect(response.status).toBe(200)
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(pdf)
        expect(response.headers.get('cache-control')).toContain('no-store')
      }
      expect(
        (
          await fetch(`${apiUrl}/api/v1/attachments/${attachment.id}/content`, {
            headers: { Cookie: cookies.south },
          })
        ).status,
      ).toBe(404)
      const deniedUpload = await fetch(`${apiUrl}/api/v1/attachments?${query}`, {
        method: 'POST',
        headers: {
          Cookie: cookies.south,
          'Content-Type': 'application/pdf',
          'x-file-name': 'foreign.pdf',
        },
        body: new Blob([pdf]),
      })
      expect(deniedUpload.status).toBe(404)
    } finally {
      const saved = await pool.query('delete from attachments where id=$1 returning object_key', [
        attachment.id,
      ])
      if (saved.rows[0]) await removeStoredProof(saved.rows[0].object_key)
    }
  })

  it('keeps CSV export branch-scoped despite forged filters and requires the export grant', async () => {
    await createCompletedReportOrder('north', branchId, customerId, reportNorthUserId, '20.00')
    await createCompletedReportOrder(
      'south',
      otherBranchId,
      otherCustomerId,
      reportSouthUserId,
      '40.00',
    )

    const year = new Date().getUTCFullYear()
    const query = new URLSearchParams({
      report: 'sales-by-branch',
      dateFrom: `${year}-01-01`,
      dateTo: `${year}-12-31`,
    })
    const exportCsv = async (account: string, forgedBranchId: string) => {
      const branchQuery = new URLSearchParams(query)
      branchQuery.set('branchId', forgedBranchId)
      const response = await fetch(`${apiUrl}/api/v1/reports/export?${branchQuery.toString()}`, {
        headers: { Cookie: cookies[account] ?? '' },
      })
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        text: await response.text(),
      }
    }

    const northCsv = await exportCsv('report-north', otherBranchId)
    expect(northCsv.status).toBe(200)
    expect(northCsv.contentType).toContain('text/csv')
    expect(northCsv.text).toContain(`Delivery route North ${fixture}`)
    expect(northCsv.text).not.toContain(`Delivery route South ${fixture}`)
    expect(northCsv.text).toContain('20.00')
    expect(northCsv.text).not.toContain('40.00')

    const southCsv = await exportCsv('report-south', branchId)
    expect(southCsv.status).toBe(200)
    expect(southCsv.text).toContain(`Delivery route South ${fixture}`)
    expect(southCsv.text).not.toContain(`Delivery route North ${fixture}`)
    expect(southCsv.text).toContain('40.00')
    expect(southCsv.text).not.toContain('20.00')

    const denied = await request<ApiError>(
      'GET',
      `/reports/export?${query.toString()}`,
      'report-viewer',
    )
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('FORBIDDEN')
  })
})
