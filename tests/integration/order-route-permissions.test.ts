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

type ApiError = { error: { code: string; message: string } }
type OrderCreated = { id: string; orderNumber: string; totalAmount: string }
type OrderDetail = {
  id: string
  status: string
  history: { action: string }[]
  items: { id: string; quantity: string }[]
}
type WorkflowRecord = { id: string; status: string; amount?: string }
type Eligibility = {
  cancellation: { canCancel: boolean }
  completion: { canComplete: boolean; blockingReasons: { code: string }[] }
}

let server: Server
let apiUrl: string
let branchId: string
let otherBranchId: string
let customerId: string
let otherBranchCustomerId: string
let productId: string
let actorId: string
const cookies: Record<string, string> = {}

async function insertId(query: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(query, values)
  const id = result.rows[0]?.id
  if (!id) throw new Error('The HTTP integration fixture could not be created.')
  return id
}

async function createAccount(
  label: string,
  fixture: string,
  accountBranchId: string,
  permissionKeys: string[],
) {
  const roleId = await insertId('insert into roles (name) values ($1) returning id', [
    `Order HTTP ${label} ${fixture}`,
  ])
  for (const permission of permissionKeys) {
    await pool.query('insert into role_permissions (role_id, permission_key) values ($1, $2)', [
      roleId,
      permission,
    ])
  }
  const userId = await insertId(
    `insert into users (email, name, password_hash, role_id, branch_id, status)
     values ($1, $2, 'unused-test-hash', $3, $4, 'Active') returning id`,
    [`order-${label}-${fixture}@example.invalid`, `Order HTTP ${label}`, roleId, accountBranchId],
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
  const payment = method === 'POST' && path === '/payments' && body
  const response = await fetch(`${apiUrl}/api/v1${payment ? '/payments/with-proof' : path}`, {
    method,
    headers: {
      ...(account ? { Cookie: cookies[account] ?? '' } : {}),
      ...(body && !payment ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: payment ? paymentProofForm(body) : JSON.stringify(body) } : {}),
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

async function createOrder() {
  const response = await request<OrderCreated>('POST', '/orders', 'operator', {
    customerId,
    branchId,
    items: [{ productId, quantity: 2 }],
  })
  expect(response.status).toBe(201)
  expect(response.body.totalAmount).toBe('20.00')
  return response.body.id
}

async function payOrder(orderId: string) {
  const response = await request<{ id: string }>('POST', '/payments', 'operator', {
    orderId,
    amount: '20.00',
    method: 'Cash',
  })
  expect(response.status).toBe(201)
  return response.body.id
}

async function deliverOrder(orderId: string) {
  const order = await request<OrderDetail>('GET', `/orders/${orderId}`, 'operator')
  const itemId = order.body.items[0]?.id
  if (!itemId) throw new Error('The order test item is missing.')
  const delivery = await request<{ id: string }>('POST', '/deliveries', 'operator', {
    orderId,
    destination: 'Integration project site',
    items: [{ orderItemId: itemId, quantity: '2' }],
  })
  expect(delivery.status).toBe(201)
  for (const status of ['In Transit', 'Delivered']) {
    const transition = await request<{ status: string }>(
      'PATCH',
      `/deliveries/${delivery.body.id}/status`,
      'operator',
      { status },
    )
    expect(transition.status).toBe(200)
    expect(transition.body.status).toBe(status)
  }
  return { deliveryId: delivery.body.id, itemId }
}

beforeAll(async () => {
  const fixture = randomUUID().slice(0, 8)
  const permissionKeys = [
    'sales.read',
    'orders.create',
    'orders.cancel',
    'orders.complete',
    'payments.create',
    'deliveries.create',
    'deliveries.update',
    'payments.refund.request',
    'payments.refund.approve',
    'payments.refund.process',
    'returns.create',
    'returns.approve',
    'returns.receive',
    'audit.read',
    'payments.read',
  ]
  for (const key of permissionKeys) {
    await pool.query(
      'insert into permissions (key, description) values ($1, $2) on conflict (key) do nothing',
      [key, `HTTP acceptance ${key}`],
    )
  }
  branchId = await insertId('insert into branches (name, code) values ($1, $2) returning id', [
    'Order HTTP North',
    `oh-n-${fixture}`,
  ])
  otherBranchId = await insertId('insert into branches (name, code) values ($1, $2) returning id', [
    'Order HTTP South',
    `oh-s-${fixture}`,
  ])
  customerId = await insertId(
    'insert into customers (name, branch_id) values ($1, $2) returning id',
    [`Order HTTP customer ${fixture}`, branchId],
  )
  otherBranchCustomerId = await insertId(
    'insert into customers (name, branch_id) values ($1, $2) returning id',
    [`Order HTTP other branch customer ${fixture}`, otherBranchId],
  )
  productId = await insertId(
    `insert into products (name, sku, category, unit, unit_price)
     values ($1, $2, 'Materials', 'piece', '10.00') returning id`,
    [`Order HTTP product ${fixture}`, `OH-${fixture}`],
  )
  await pool.query('insert into inventory (product_id, branch_id, quantity) values ($1, $2, $3)', [
    productId,
    branchId,
    '100.000',
  ])
  actorId = await createAccount('operator', fixture, branchId, [
    ...permissionKeys.slice(0, 7),
    'payments.read',
  ])
  await createAccount('viewer', fixture, branchId, ['sales.read'])
  await createAccount('auditor', fixture, branchId, ['sales.read', 'audit.read'])
  await createAccount('outsider', fixture, otherBranchId, permissionKeys)
  await createAccount('unprivileged', fixture, branchId, [])
  await createAccount('requester', fixture, branchId, [
    'sales.read',
    'payments.refund.request',
    'returns.create',
  ])
  await createAccount('approver', fixture, branchId, [
    'sales.read',
    'payments.refund.approve',
    'returns.approve',
  ])
  await createAccount('processor', fixture, branchId, [
    'sales.read',
    'payments.refund.process',
    'returns.receive',
  ])

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('The HTTP test server did not start.')
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

describe('order lifecycle HTTP authorization', () => {
  it('replays order creation safely and keeps route permission checks in front of replay', async () => {
    const requestKey = randomUUID()
    const body = {
      customerId,
      branchId,
      requestKey: requestKey.toUpperCase(),
      items: [{ productId, quantity: 2 }],
    }
    const [first, replay] = await Promise.all([
      request<OrderCreated>('POST', '/orders', 'operator', body),
      request<OrderCreated>('POST', '/orders', 'operator', body),
    ])
    expect(first.status).toBe(201)
    expect(replay).toEqual(first)

    const changed = await request<ApiError>('POST', '/orders', 'operator', {
      ...body,
      requestKey,
      items: [{ productId, quantity: 3 }],
    })
    expect(changed.status).toBe(409)
    expect(changed.body.error.code).toBe('REQUEST_KEY_CONFLICT')

    const unauthorized = await request<ApiError>('POST', '/orders', 'unprivileged', body)
    expect(unauthorized.status).toBe(403)
    expect(unauthorized.body.error.code).toBe('FORBIDDEN')

    const crossBranchCustomer = await request<ApiError>('POST', '/orders', 'operator', {
      customerId: otherBranchCustomerId,
      branchId,
      items: [{ productId, quantity: 1 }],
    })
    expect(crossBranchCustomer.status).toBe(404)
    expect(crossBranchCustomer.body.error.code).toBe('CUSTOMER_NOT_FOUND')

    const counts = await pool.query<{
      orders: string
      reservations: string
      movements: string
      audits: string
    }>(
      `select count(distinct o.id)::text as orders, count(distinct r.id)::text as reservations,
              count(distinct it.id)::text as movements, count(distinct a.id)::text as audits
         from orders o
         left join order_items oi on oi.order_id = o.id
         left join order_reservations r on r.order_item_id = oi.id
         left join inventory_transactions it on it.reference_type = 'Order' and it.reference_id = o.id
         left join audit_logs a on a.entity_type = 'order' and a.entity_id = o.id
        where o.request_key = $1`,
      [requestKey],
    )
    expect(counts.rows[0]).toEqual({ orders: '1', reservations: '1', movements: '1', audits: '1' })
  })

  it('requires a database-backed session for reads and lifecycle mutations', async () => {
    const orderId = await createOrder()
    const paths = [
      ['GET', `/orders/${orderId}`],
      ['GET', `/orders/${orderId}/lifecycle-eligibility`],
      ['POST', `/orders/${orderId}/complete`],
      ['POST', `/orders/${orderId}/cancel`],
    ] as const
    for (const [method, path] of paths) {
      const result = await request<ApiError>(method, path)
      expect(result.status).toBe(401)
      expect(result.body.error.code).toBe('AUTH_REQUIRED')
    }
    const forged = await fetch(`${apiUrl}/api/v1/orders/${orderId}`, {
      headers: { Cookie: `${sessionCookieName}=not-a-session` },
    })
    expect(forged.status).toBe(401)
    await expect(forged.json()).resolves.toMatchObject({
      error: { code: 'SESSION_EXPIRED' },
    })
  })

  it('enforces read permission, branch scope, and audit-log filtering on detail', async () => {
    const orderId = await createOrder()
    await pool.query(
      `insert into audit_logs (user_id, branch_id, action, entity_type, entity_id)
       values ($1, $2, 'unrelated branch audit', 'order', $3)`,
      [actorId, otherBranchId, orderId],
    )

    const viewer = await request<OrderDetail>('GET', `/orders/${orderId}`, 'viewer')
    expect(viewer.status).toBe(200)
    expect(viewer.body.history).toEqual([])
    const auditor = await request<OrderDetail>('GET', `/orders/${orderId}`, 'auditor')
    expect(auditor.status).toBe(200)
    expect(auditor.body.history.map((entry) => entry.action)).toEqual(['created order'])
    const noRead = await request<ApiError>('GET', `/orders/${orderId}`, 'unprivileged')
    expect(noRead.status).toBe(403)
    expect(noRead.body.error.code).toBe('FORBIDDEN')
    const outsider = await request<ApiError>('GET', `/orders/${orderId}`, 'outsider')
    expect(outsider.status).toBe(404)
    expect(outsider.body.error.code).toBe('ORDER_NOT_FOUND')

    const eligibility = await request<Eligibility>(
      'GET',
      `/orders/${orderId}/lifecycle-eligibility`,
      'viewer',
    )
    expect(eligibility.status).toBe(200)
    expect(eligibility.body.cancellation.canCancel).toBe(true)
    const deniedEligibility = await request<ApiError>(
      'GET',
      `/orders/${orderId}/lifecycle-eligibility`,
      'outsider',
    )
    expect(deniedEligibility.status).toBe(404)
    const noReadEligibility = await request<ApiError>(
      'GET',
      `/orders/${orderId}/lifecycle-eligibility`,
      'unprivileged',
    )
    expect(noReadEligibility.status).toBe(403)
  })

  it('shows relationally linked workflow events without leaking another order or branch', async () => {
    const orderId = await createOrder()
    const unrelatedOrderId = await createOrder()
    const paymentId = await payOrder(orderId)
    const unrelatedPaymentId = await payOrder(unrelatedOrderId)
    const { deliveryId, itemId } = await deliverOrder(orderId)
    await pool.query(
      `insert into audit_logs (user_id, branch_id, action, entity_type, entity_id)
       values ($1, $2, 'reconciled legacy delivery allocation', 'delivery', $3)`,
      [actorId, branchId, deliveryId],
    )

    const refund = await request<WorkflowRecord>(
      'POST',
      `/orders/${orderId}/refunds`,
      'requester',
      {
        requestKey: randomUUID(),
        paymentId,
        amount: '5.00',
        method: 'Cash',
        reason: 'Linked timeline refund',
      },
    )
    expect(refund.status).toBe(201)
    expect(
      (await request<WorkflowRecord>('PATCH', `/refunds/${refund.body.id}/approve`, 'approver'))
        .status,
    ).toBe(200)
    expect(
      (
        await request<WorkflowRecord>(
          'PATCH',
          `/refunds/${refund.body.id}/process`,
          'processor',
          {},
        )
      ).status,
    ).toBe(200)

    const returned = await request<WorkflowRecord>(
      'POST',
      `/orders/${orderId}/returns`,
      'requester',
      {
        requestKey: randomUUID(),
        deliveryId,
        reason: 'Linked timeline return',
        items: [{ orderItemId: itemId, quantity: '1' }],
      },
    )
    expect(returned.status).toBe(201)
    expect(
      (await request<WorkflowRecord>('PATCH', `/returns/${returned.body.id}/approve`, 'approver'))
        .status,
    ).toBe(200)
    expect(
      (
        await request<WorkflowRecord>(
          'PATCH',
          `/returns/${returned.body.id}/receive`,
          'processor',
          {
            items: [{ orderItemId: itemId, condition: 'Resalable', acceptedQuantity: '1' }],
          },
        )
      ).status,
    ).toBe(200)

    await pool.query(
      `insert into audit_logs (user_id, branch_id, action, entity_type, entity_id, new_value)
       values ($1, $2, 'spoofed linked payment', 'payment', $3, $4)`,
      [actorId, branchId, unrelatedPaymentId, { orderId }],
    )
    await pool.query(
      `insert into audit_logs (user_id, branch_id, action, entity_type, entity_id)
       values ($1, $2, 'foreign branch linked payment', 'payment', $3)`,
      [actorId, otherBranchId, paymentId],
    )

    const auditor = await request<OrderDetail>('GET', `/orders/${orderId}`, 'auditor')
    expect(auditor.status).toBe(200)
    const actions = auditor.body.history.map((entry) => entry.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        'created order',
        'recorded payment',
        'created delivery',
        'updated delivery status',
        'confirmed order delivery',
        'reconciled legacy delivery allocation',
        'requested payment refund',
        'approved payment refund',
        'processed payment refund',
        'requested order return',
        'approved order return',
        'received order return',
      ]),
    )
    expect(actions.filter((action) => action === 'created delivery')).toHaveLength(1)
    expect(actions).not.toContain('spoofed linked payment')
    expect(actions).not.toContain('foreign branch linked payment')

    const viewer = await request<OrderDetail>('GET', `/orders/${orderId}`, 'viewer')
    expect(viewer.status).toBe(200)
    expect(viewer.body.history).toEqual([])
    const outsider = await request<ApiError>('GET', `/orders/${orderId}`, 'outsider')
    expect(outsider.status).toBe(404)
    expect(outsider.body.error.code).toBe('ORDER_NOT_FOUND')
  })

  it('keeps only the newest 25 linked audit events', async () => {
    const orderId = await createOrder()
    await pool.query(
      `insert into audit_logs (user_id, branch_id, action, entity_type, entity_id, created_at)
       select $1, $2, 'timeline marker ' || n, 'order', $3, now() + n * interval '1 second'
         from generate_series(0, 26) as n`,
      [actorId, branchId, orderId],
    )
    const detail = await request<OrderDetail>('GET', `/orders/${orderId}`, 'auditor')
    expect(detail.status).toBe(200)
    expect(detail.body.history).toHaveLength(25)
    expect(detail.body.history[0]?.action).toBe('timeline marker 26')
    expect(detail.body.history[24]?.action).toBe('timeline marker 2')
  })

  it('rejects forbidden and cross-branch lifecycle mutations without changing the order', async () => {
    const orderId = await createOrder()
    for (const action of ['complete', 'cancel']) {
      const denied = await request<ApiError>('POST', `/orders/${orderId}/${action}`, 'viewer', {
        reason: 'customer request',
      })
      expect(denied.status).toBe(403)
      expect(denied.body.error.code).toBe('FORBIDDEN')
      const otherBranch = await request<ApiError>(
        'POST',
        `/orders/${orderId}/${action}`,
        'outsider',
        { reason: 'customer request' },
      )
      expect(otherBranch.status).toBe(404)
      expect(otherBranch.body.error.code).toBe('ORDER_NOT_FOUND')
    }
    const malformed = await request<ApiError>('POST', `/orders/${orderId}/cancel`, 'operator', {
      reason: 'not an approved reason',
    })
    expect(malformed.status).toBe(400)
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR')
    const stored = await pool.query<{ status: string }>('select status from orders where id = $1', [
      orderId,
    ])
    expect(stored.rows[0]?.status).toBe('Processing')
    const audit = await pool.query<{ action: string }>(
      `select action from audit_logs where entity_type = 'order' and entity_id = $1`,
      [orderId],
    )
    expect(audit.rows.map((row) => row.action)).toEqual(['created order'])
  })

  it('allows cancellation only for an authorized same-branch actor and records the result', async () => {
    const orderId = await createOrder()
    const reservedBefore = await pool.query<{ reserved_quantity: string }>(
      'select reserved_quantity::text from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    const cancelled = await request<{ status: string }>(
      'POST',
      `/orders/${orderId}/cancel`,
      'operator',
      { reason: 'customer request' },
    )
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.status).toBe('Cancelled')
    const repeated = await request<ApiError>('POST', `/orders/${orderId}/cancel`, 'operator', {
      reason: 'customer request',
    })
    expect(repeated.status).toBe(409)
    expect(repeated.body.error.code).toBe('ORDER_ALREADY_CANCELLED')
    const detail = await request<OrderDetail>('GET', `/orders/${orderId}`, 'auditor')
    expect(detail.body.status).toBe('Cancelled')
    expect(detail.body.history.map((entry) => entry.action)).toEqual([
      'cancelled order',
      'created order',
    ])
    const inventory = await pool.query<{ reserved_quantity: string }>(
      'select reserved_quantity::text from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    expect(Number(inventory.rows[0]?.reserved_quantity)).toBe(
      Number(reservedBefore.rows[0]?.reserved_quantity) - 2,
    )
  })

  it('blocks completion for pending reversals, then permits later refund and return without direct cancellation', async () => {
    const orderId = await createOrder()
    const premature = await request<ApiError>('POST', `/orders/${orderId}/complete`, 'operator')
    expect(premature.status).toBe(409)
    expect(premature.body.error.code).toBe('ORDER_NOT_FULLY_DELIVERED')

    const paymentId = await payOrder(orderId)
    const { deliveryId, itemId } = await deliverOrder(orderId)

    const pendingRefund = await request<WorkflowRecord>(
      'POST',
      `/orders/${orderId}/refunds`,
      'requester',
      {
        requestKey: randomUUID(),
        paymentId,
        amount: '5.00',
        method: 'Cash',
        reason: 'Review customer request',
      },
    )
    expect(pendingRefund.status).toBe(201)
    const refundBlocked = await request<ApiError>('POST', `/orders/${orderId}/complete`, 'operator')
    expect(refundBlocked.status).toBe(409)
    expect(refundBlocked.body.error.code).toBe('REFUND_PENDING')
    const rejectedRefund = await request<WorkflowRecord>(
      'PATCH',
      `/refunds/${pendingRefund.body.id}/reject`,
      'approver',
      { reason: 'Request withdrawn' },
    )
    expect(rejectedRefund.body.status).toBe('Rejected')

    const pendingReturn = await request<WorkflowRecord>(
      'POST',
      `/orders/${orderId}/returns`,
      'requester',
      {
        requestKey: randomUUID(),
        deliveryId,
        reason: 'Review material condition',
        items: [{ orderItemId: itemId, quantity: '1' }],
      },
    )
    expect(pendingReturn.status).toBe(201)
    const returnBlocked = await request<ApiError>('POST', `/orders/${orderId}/complete`, 'operator')
    expect(returnBlocked.status).toBe(409)
    expect(returnBlocked.body.error.code).toBe('RETURN_PENDING')
    const rejectedReturn = await request<WorkflowRecord>(
      'PATCH',
      `/returns/${pendingReturn.body.id}/reject`,
      'approver',
      { reason: 'Request withdrawn' },
    )
    expect(rejectedReturn.body.status).toBe('Rejected')

    const eligibility = await request<Eligibility>(
      'GET',
      `/orders/${orderId}/lifecycle-eligibility`,
      'operator',
    )
    expect(eligibility.status).toBe(200)
    expect(eligibility.body.completion.canComplete).toBe(true)
    const completed = await request<{ status: string }>(
      'POST',
      `/orders/${orderId}/complete`,
      'operator',
    )
    expect(completed.status).toBe(200)
    expect(completed.body.status).toBe('Completed')
    const repeated = await request<ApiError>('POST', `/orders/${orderId}/complete`, 'operator')
    expect(repeated.status).toBe(409)
    expect(repeated.body.error.code).toBe('ORDER_ALREADY_COMPLETED')
    const directCancellation = await request<ApiError>(
      'POST',
      `/orders/${orderId}/cancel`,
      'operator',
      { reason: 'customer request' },
    )
    expect(directCancellation.status).toBe(409)
    expect(directCancellation.body.error.code).toBe('ORDER_ALREADY_COMPLETED')

    const quantityBeforeReturn = await pool.query<{ quantity: string }>(
      'select quantity::text as quantity from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    const laterRefund = await request<WorkflowRecord>(
      'POST',
      `/orders/${orderId}/refunds`,
      'requester',
      {
        requestKey: randomUUID(),
        paymentId,
        amount: '5.00',
        method: 'Cash',
        reason: 'Post-completion adjustment',
      },
    )
    expect(laterRefund.status).toBe(201)
    const approvedRefund = await request<WorkflowRecord>(
      'PATCH',
      `/refunds/${laterRefund.body.id}/approve`,
      'approver',
    )
    expect(approvedRefund.body.status).toBe('Approved')
    const processedRefund = await request<WorkflowRecord>(
      'PATCH',
      `/refunds/${laterRefund.body.id}/process`,
      'processor',
      {},
    )
    expect(processedRefund.status).toBe(200)
    expect(processedRefund.body.status).toBe('Processed')

    const laterReturn = await request<WorkflowRecord>(
      'POST',
      `/orders/${orderId}/returns`,
      'requester',
      {
        requestKey: randomUUID(),
        deliveryId,
        reason: 'Post-completion material return',
        items: [{ orderItemId: itemId, quantity: '1' }],
      },
    )
    expect(laterReturn.status).toBe(201)
    const approvedReturn = await request<WorkflowRecord>(
      'PATCH',
      `/returns/${laterReturn.body.id}/approve`,
      'approver',
    )
    expect(approvedReturn.body.status).toBe('Approved')
    const receivedReturn = await request<WorkflowRecord>(
      'PATCH',
      `/returns/${laterReturn.body.id}/receive`,
      'processor',
      { items: [{ orderItemId: itemId, condition: 'Resalable', acceptedQuantity: '1' }] },
    )
    expect(receivedReturn.status).toBe(200)
    expect(receivedReturn.body.status).toBe('Received')
    const quantityAfterReturn = await pool.query<{ quantity: string }>(
      'select quantity::text as quantity from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    expect(Number(quantityAfterReturn.rows[0]?.quantity)).toBe(
      Number(quantityBeforeReturn.rows[0]?.quantity) + 1,
    )
    const detail = await request<OrderDetail>('GET', `/orders/${orderId}`, 'auditor')
    expect(detail.body.status).toBe('Completed')
    const actions = detail.body.history.map((entry) => entry.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        'completed order',
        'confirmed order delivery',
        'created delivery',
        'recorded payment',
        'requested payment refund',
        'rejected payment refund',
        'approved payment refund',
        'processed payment refund',
        'requested order return',
        'rejected order return',
        'approved order return',
        'received order return',
        'created order',
      ]),
    )
  })

  it('enforces refund permissions and branch scope through request, approval, and processing', async () => {
    const orderId = await createOrder()
    const paymentId = await payOrder(orderId)
    const refundInput = {
      requestKey: randomUUID(),
      paymentId,
      amount: '5.00',
      method: 'Cash',
      reason: 'Customer requested refund',
    }
    const unauthenticated = await request<ApiError>('GET', `/orders/${orderId}/refunds`)
    expect(unauthenticated.status).toBe(401)
    const missingRequest = await request<ApiError>(
      'POST',
      `/orders/${orderId}/refunds`,
      'operator',
      refundInput,
    )
    expect(missingRequest.status).toBe(403)
    const wrongBranchRequest = await request<ApiError>(
      'POST',
      `/orders/${orderId}/refunds`,
      'outsider',
      refundInput,
    )
    expect(wrongBranchRequest.status).toBe(404)
    const invalidRequest = await request<ApiError>(
      'POST',
      `/orders/${orderId}/refunds`,
      'requester',
      { ...refundInput, amount: '0' },
    )
    expect(invalidRequest.status).toBe(400)
    expect(invalidRequest.body.error.code).toBe('VALIDATION_ERROR')

    const requested = await request<WorkflowRecord>(
      'POST',
      `/orders/${orderId}/refunds`,
      'requester',
      refundInput,
    )
    expect(requested.status).toBe(201)
    expect(requested.body).toMatchObject({ status: 'Requested', amount: '5.00' })
    const refundId = requested.body.id
    const duplicate = await request<WorkflowRecord>(
      'POST',
      `/orders/${orderId}/refunds`,
      'requester',
      refundInput,
    )
    expect(duplicate.status).toBe(201)
    expect(duplicate.body.id).toBe(refundId)
    const reusedKey = await request<ApiError>('POST', `/orders/${orderId}/refunds`, 'requester', {
      ...refundInput,
      amount: '4.00',
    })
    expect(reusedKey.status).toBe(409)
    expect(reusedKey.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED')

    const missingApproval = await request<ApiError>(
      'PATCH',
      `/refunds/${refundId}/approve`,
      'requester',
    )
    expect(missingApproval.status).toBe(403)
    const wrongBranchApproval = await request<ApiError>(
      'PATCH',
      `/refunds/${refundId}/approve`,
      'outsider',
    )
    expect(wrongBranchApproval.status).toBe(404)
    const prematureProcess = await request<ApiError>(
      'PATCH',
      `/refunds/${refundId}/process`,
      'processor',
      {},
    )
    expect(prematureProcess.status).toBe(409)
    expect(prematureProcess.body.error.code).toBe('REFUND_NOT_APPROVED')
    const approved = await request<WorkflowRecord>(
      'PATCH',
      `/refunds/${refundId}/approve`,
      'approver',
    )
    expect(approved.status).toBe(200)
    expect(approved.body.status).toBe('Approved')
    const repeatedApproval = await request<ApiError>(
      'PATCH',
      `/refunds/${refundId}/approve`,
      'approver',
    )
    expect(repeatedApproval.status).toBe(409)
    const missingProcess = await request<ApiError>(
      'PATCH',
      `/refunds/${refundId}/process`,
      'approver',
      {},
    )
    expect(missingProcess.status).toBe(403)
    const wrongBranchProcess = await request<ApiError>(
      'PATCH',
      `/refunds/${refundId}/process`,
      'outsider',
      {},
    )
    expect(wrongBranchProcess.status).toBe(404)
    const invalidProcess = await request<ApiError>(
      'PATCH',
      `/refunds/${refundId}/process`,
      'processor',
      { reference: '' },
    )
    expect(invalidProcess.status).toBe(400)
    const processed = await request<WorkflowRecord>(
      'PATCH',
      `/refunds/${refundId}/process`,
      'processor',
      { reference: 'BANK-REF-001' },
    )
    expect(processed.status).toBe(200)
    expect(processed.body.status).toBe('Processed')
    const repeatedProcess = await request<ApiError>(
      'PATCH',
      `/refunds/${refundId}/process`,
      'processor',
      {},
    )
    expect(repeatedProcess.status).toBe(409)
    expect(repeatedProcess.body.error.code).toBe('REFUND_NOT_APPROVED')

    const list = await request<WorkflowRecord[]>('GET', `/orders/${orderId}/refunds`, 'viewer')
    expect(list.status).toBe(200)
    expect(list.body).toMatchObject([{ id: refundId, status: 'Processed', amount: '5.00' }])
    const forbiddenList = await request<ApiError>(
      'GET',
      `/orders/${orderId}/refunds`,
      'unprivileged',
    )
    expect(forbiddenList.status).toBe(403)
    const wrongBranchList = await request<ApiError>('GET', `/orders/${orderId}/refunds`, 'outsider')
    expect(wrongBranchList.status).toBe(404)
    const originalPayment = await pool.query<{ amount: string; status: string }>(
      'select amount::text as amount, status from payments where id = $1',
      [paymentId],
    )
    expect(originalPayment.rows[0]).toEqual({ amount: '20.00', status: 'Paid' })
    const audit = await pool.query<{ action: string; branch_id: string }>(
      `select action, branch_id from audit_logs
       where entity_type = 'payment_refund' and entity_id = $1 order by created_at, id`,
      [refundId],
    )
    expect(audit.rows.map((entry) => entry.action)).toEqual([
      'requested payment refund',
      'approved payment refund',
      'processed payment refund',
    ])
    expect(audit.rows.every((entry) => entry.branch_id === branchId)).toBe(true)
    const scopedAudit = await request<{ total: number; data: { Action: string }[] }>(
      'GET',
      '/audit-logs?search=payment%20refund&limit=100',
      'auditor',
    )
    expect(scopedAudit.status).toBe(200)
    expect(scopedAudit.body.data.map((entry) => entry.Action)).toContain('processed payment refund')
    const otherBranchAudit = await request<{ total: number }>(
      'GET',
      '/audit-logs?search=payment%20refund&limit=100',
      'outsider',
    )
    expect(otherBranchAudit.status).toBe(200)
    expect(otherBranchAudit.body.total).toBe(0)
  })

  it('rejects refund requests with a reason, then prevents approval or processing', async () => {
    const orderId = await createOrder()
    const paymentId = await payOrder(orderId)
    const requested = await request<WorkflowRecord>(
      'POST',
      `/orders/${orderId}/refunds`,
      'requester',
      {
        requestKey: randomUUID(),
        paymentId,
        amount: '3.00',
        method: 'Cash',
        reason: 'Incorrect amount',
      },
    )
    expect(requested.status).toBe(201)
    const invalidRejection = await request<ApiError>(
      'PATCH',
      `/refunds/${requested.body.id}/reject`,
      'approver',
      { reason: '' },
    )
    expect(invalidRejection.status).toBe(400)
    const missingRejectionPermission = await request<ApiError>(
      'PATCH',
      `/refunds/${requested.body.id}/reject`,
      'requester',
      { reason: 'Duplicate request' },
    )
    expect(missingRejectionPermission.status).toBe(403)
    const wrongBranchRejection = await request<ApiError>(
      'PATCH',
      `/refunds/${requested.body.id}/reject`,
      'outsider',
      { reason: 'Duplicate request' },
    )
    expect(wrongBranchRejection.status).toBe(404)
    const rejected = await request<WorkflowRecord>(
      'PATCH',
      `/refunds/${requested.body.id}/reject`,
      'approver',
      { reason: 'Duplicate request' },
    )
    expect(rejected.status).toBe(200)
    expect(rejected.body.status).toBe('Rejected')
    const repeated = await request<ApiError>(
      'PATCH',
      `/refunds/${requested.body.id}/reject`,
      'approver',
      { reason: 'Duplicate request' },
    )
    expect(repeated.status).toBe(409)
    const process = await request<ApiError>(
      'PATCH',
      `/refunds/${requested.body.id}/process`,
      'processor',
      {},
    )
    expect(process.status).toBe(409)
    expect(process.body.error.code).toBe('REFUND_NOT_APPROVED')
  })

  it('enforces return permissions and restores only classified resalable stock', async () => {
    const orderId = await createOrder()
    const { deliveryId, itemId } = await deliverOrder(orderId)
    const quantityBefore = await pool.query<{ quantity: string }>(
      'select quantity::text as quantity from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    const returnInput = {
      requestKey: randomUUID(),
      deliveryId,
      reason: 'Unused material',
      items: [{ orderItemId: itemId, quantity: '1' }],
    }
    const unauthenticated = await request<ApiError>('GET', `/orders/${orderId}/returns`)
    expect(unauthenticated.status).toBe(401)
    const missingRequest = await request<ApiError>(
      'POST',
      `/orders/${orderId}/returns`,
      'operator',
      returnInput,
    )
    expect(missingRequest.status).toBe(403)
    const wrongBranchRequest = await request<ApiError>(
      'POST',
      `/orders/${orderId}/returns`,
      'outsider',
      returnInput,
    )
    expect(wrongBranchRequest.status).toBe(404)
    const invalidRequest = await request<ApiError>(
      'POST',
      `/orders/${orderId}/returns`,
      'requester',
      { ...returnInput, items: [{ orderItemId: itemId, quantity: '0' }] },
    )
    expect(invalidRequest.status).toBe(400)
    const requested = await request<WorkflowRecord>(
      'POST',
      `/orders/${orderId}/returns`,
      'requester',
      returnInput,
    )
    expect(requested.status).toBe(201)
    expect(requested.body.status).toBe('Requested')
    const returnId = requested.body.id
    const duplicate = await request<WorkflowRecord>(
      'POST',
      `/orders/${orderId}/returns`,
      'requester',
      returnInput,
    )
    expect(duplicate.status).toBe(201)
    expect(duplicate.body.id).toBe(returnId)
    const reusedKey = await request<ApiError>('POST', `/orders/${orderId}/returns`, 'requester', {
      ...returnInput,
      items: [{ orderItemId: itemId, quantity: '2' }],
    })
    expect(reusedKey.status).toBe(409)
    expect(reusedKey.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    const missingApproval = await request<ApiError>(
      'PATCH',
      `/returns/${returnId}/approve`,
      'requester',
    )
    expect(missingApproval.status).toBe(403)
    const wrongBranchApproval = await request<ApiError>(
      'PATCH',
      `/returns/${returnId}/approve`,
      'outsider',
    )
    expect(wrongBranchApproval.status).toBe(404)
    const prematureReceive = await request<ApiError>(
      'PATCH',
      `/returns/${returnId}/receive`,
      'processor',
      { items: [{ orderItemId: itemId, condition: 'Resalable', acceptedQuantity: '1' }] },
    )
    expect(prematureReceive.status).toBe(409)
    expect(prematureReceive.body.error.code).toBe('RETURN_NOT_APPROVED')
    const approved = await request<WorkflowRecord>(
      'PATCH',
      `/returns/${returnId}/approve`,
      'approver',
    )
    expect(approved.status).toBe(200)
    expect(approved.body.status).toBe('Approved')
    const repeatedApproval = await request<ApiError>(
      'PATCH',
      `/returns/${returnId}/approve`,
      'approver',
    )
    expect(repeatedApproval.status).toBe(409)
    const missingReceive = await request<ApiError>(
      'PATCH',
      `/returns/${returnId}/receive`,
      'approver',
      { items: [{ orderItemId: itemId, condition: 'Resalable', acceptedQuantity: '1' }] },
    )
    expect(missingReceive.status).toBe(403)
    const wrongBranchReceive = await request<ApiError>(
      'PATCH',
      `/returns/${returnId}/receive`,
      'outsider',
      { items: [{ orderItemId: itemId, condition: 'Resalable', acceptedQuantity: '1' }] },
    )
    expect(wrongBranchReceive.status).toBe(404)
    const invalidClassification = await request<ApiError>(
      'PATCH',
      `/returns/${returnId}/receive`,
      'processor',
      { items: [{ orderItemId: itemId, condition: 'Damaged', acceptedQuantity: '1' }] },
    )
    expect(invalidClassification.status).toBe(400)
    expect(invalidClassification.body.error.code).toBe('VALIDATION_ERROR')
    const received = await request<WorkflowRecord>(
      'PATCH',
      `/returns/${returnId}/receive`,
      'processor',
      { items: [{ orderItemId: itemId, condition: 'Resalable', acceptedQuantity: '1' }] },
    )
    expect(received.status).toBe(200)
    expect(received.body.status).toBe('Received')
    const repeatedReceive = await request<ApiError>(
      'PATCH',
      `/returns/${returnId}/receive`,
      'processor',
      { items: [{ orderItemId: itemId, condition: 'Resalable', acceptedQuantity: '1' }] },
    )
    expect(repeatedReceive.status).toBe(409)

    const damagedRequest = await request<WorkflowRecord>(
      'POST',
      `/orders/${orderId}/returns`,
      'requester',
      { ...returnInput, requestKey: randomUUID() },
    )
    expect(damagedRequest.status).toBe(201)
    const damagedApproval = await request<WorkflowRecord>(
      'PATCH',
      `/returns/${damagedRequest.body.id}/approve`,
      'approver',
    )
    expect(damagedApproval.status).toBe(200)
    const damagedReceive = await request<WorkflowRecord>(
      'PATCH',
      `/returns/${damagedRequest.body.id}/receive`,
      'processor',
      { items: [{ orderItemId: itemId, condition: 'Damaged', acceptedQuantity: '0' }] },
    )
    expect(damagedReceive.status).toBe(200)
    const quantityAfter = await pool.query<{ quantity: string }>(
      'select quantity::text as quantity from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    expect(Number(quantityAfter.rows[0]?.quantity)).toBe(
      Number(quantityBefore.rows[0]?.quantity) + 1,
    )
    const restockMovements = await pool.query<{ quantity_delta: string }>(
      `select quantity_delta::text as quantity_delta from inventory_transactions
       where reference_type = 'OrderReturn' and reference_id in ($1, $2)`,
      [returnId, damagedRequest.body.id],
    )
    expect(restockMovements.rows).toEqual([{ quantity_delta: '1.000' }])
    const list = await request<WorkflowRecord[]>('GET', `/orders/${orderId}/returns`, 'viewer')
    expect(list.status).toBe(200)
    expect(list.body).toMatchObject([{ status: 'Received' }, { status: 'Received' }])
    const forbiddenList = await request<ApiError>(
      'GET',
      `/orders/${orderId}/returns`,
      'unprivileged',
    )
    expect(forbiddenList.status).toBe(403)
    const wrongBranchList = await request<ApiError>('GET', `/orders/${orderId}/returns`, 'outsider')
    expect(wrongBranchList.status).toBe(404)
    const audit = await pool.query<{ action: string; branch_id: string }>(
      `select action, branch_id from audit_logs
       where entity_type = 'order_return' and entity_id = $1 order by created_at, id`,
      [returnId],
    )
    expect(audit.rows.map((entry) => entry.action)).toEqual([
      'requested order return',
      'approved order return',
      'received order return',
    ])
    expect(audit.rows.every((entry) => entry.branch_id === branchId)).toBe(true)
    const otherBranchAudit = await request<{ total: number }>(
      'GET',
      '/audit-logs?search=order%20return&limit=100',
      'outsider',
    )
    expect(otherBranchAudit.status).toBe(200)
    expect(otherBranchAudit.body.total).toBe(0)
  })

  it('rejects return requests with a reason, then prevents approval or receiving', async () => {
    const orderId = await createOrder()
    const { deliveryId, itemId } = await deliverOrder(orderId)
    const requested = await request<WorkflowRecord>(
      'POST',
      `/orders/${orderId}/returns`,
      'requester',
      {
        requestKey: randomUUID(),
        deliveryId,
        reason: 'Wrong material',
        items: [{ orderItemId: itemId, quantity: '1' }],
      },
    )
    expect(requested.status).toBe(201)
    const invalidRejection = await request<ApiError>(
      'PATCH',
      `/returns/${requested.body.id}/reject`,
      'approver',
      { reason: '' },
    )
    expect(invalidRejection.status).toBe(400)
    const missingRejectionPermission = await request<ApiError>(
      'PATCH',
      `/returns/${requested.body.id}/reject`,
      'requester',
      { reason: 'Already inspected' },
    )
    expect(missingRejectionPermission.status).toBe(403)
    const wrongBranchRejection = await request<ApiError>(
      'PATCH',
      `/returns/${requested.body.id}/reject`,
      'outsider',
      { reason: 'Already inspected' },
    )
    expect(wrongBranchRejection.status).toBe(404)
    const rejected = await request<WorkflowRecord>(
      'PATCH',
      `/returns/${requested.body.id}/reject`,
      'approver',
      { reason: 'Already inspected' },
    )
    expect(rejected.status).toBe(200)
    expect(rejected.body.status).toBe('Rejected')
    const repeated = await request<ApiError>(
      'PATCH',
      `/returns/${requested.body.id}/reject`,
      'approver',
      { reason: 'Already inspected' },
    )
    expect(repeated.status).toBe(409)
    const receive = await request<ApiError>(
      'PATCH',
      `/returns/${requested.body.id}/receive`,
      'processor',
      { items: [{ orderItemId: itemId, condition: 'Resalable', acceptedQuantity: '1' }] },
    )
    expect(receive.status).toBe(409)
    expect(receive.body.error.code).toBe('RETURN_NOT_APPROVED')
    const list = await request<WorkflowRecord[]>('GET', `/orders/${orderId}/returns`, 'viewer')
    expect(list.body).toMatchObject([{ status: 'Rejected' }])
  })
})
