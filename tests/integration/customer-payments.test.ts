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
import { getCustomerBalanceSummary } from '@/features/payments/payment-balances.repository.js'
import { queryCustomerPaymentReport } from '@/features/payments/payment-reports.repository.js'
import { paymentProofForm } from './financial-proof-fixture.js'

type Detail = {
  id: string
  payableAmount: string
  paymentsAmount: string
  refundedAmount: string
  netPaidAmount: string
  balance: string
  paymentStatus: string
  history: { action: string }[]
  canRecordPayment: boolean
  payments: {
    id: string
    reference: string
    amount: string
    paymentDate: string
    externalReference: string | null
    notes: string | null
  }[]
}
type List = { data: Record<string, string>[]; total: number; statusOptions: string[] }
type ErrorBody = { error: { code: string } }
type Created = { id: string; reference: string; remainingBalance: string }
const fixture = randomUUID().slice(0, 8)
let server: Server
let apiUrl: string
let branchId: string
let otherBranchId: string
let actorId: string
let customerId: string
let productId: string
let sequence = 0
const cookies: Record<string, string> = {}

async function insertId(query: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(query, values)
  if (!result.rows[0]) throw new Error('Could not create payment acceptance fixture.')
  return result.rows[0].id
}

async function account(label: string, branch: string | null, permissions: string[]) {
  const roleId = await insertId('insert into roles (name) values ($1) returning id', [
    `Customer payments ${label} ${fixture}`,
  ])
  for (const key of permissions)
    await pool.query('insert into role_permissions (role_id, permission_key) values ($1,$2)', [
      roleId,
      key,
    ])
  const id = await insertId(
    `insert into users (name,email,password_hash,role_id,branch_id,status) values ($1,$2,'test-unused',$3,$4,'Active') returning id`,
    [`Payment ${label}`, `pay-${label}-${fixture}@example.invalid`, roleId, branch],
  )
  const token = createSessionToken()
  await pool.query(
    "insert into user_sessions (user_id,token_hash,expires_at) values ($1,$2,now()+interval '1 hour')",
    [id, hashSessionToken(token)],
  )
  cookies[label] = `${sessionCookieName}=${token}`
  return id
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
      ...(actor ? { Cookie: cookies[actor] } : {}),
      ...(body && !payment ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: payment ? paymentProofForm(body) : JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: (await response.json()) as T }
}

async function makeOrder(amount = '100.00', branch = branchId, status = 'Processing') {
  sequence++
  const number = `CP-${fixture}-${sequence}`
  const id = await insertId(
    `insert into orders (order_number,customer_id,branch_id,total_amount,status,created_by) values ($1,$2,$3,$4,$5,$6) returning id`,
    [number, customerId, branch, amount, status, actorId],
  )
  await pool.query(
    'insert into order_items (order_id,product_id,quantity,unit_price,line_total) values ($1,$2,1,$3,$3)',
    [id, productId, amount],
  )
  return { id, number }
}

async function pay(orderId: string, amount: string, metadata: Record<string, unknown> = {}) {
  return request<Created>('POST', '/payments', 'operator', {
    orderId,
    amount,
    method: 'Cash',
    ...metadata,
  })
}

async function refund(orderId: string, paymentId: string, amount: string, status: string) {
  return insertId(
    `insert into payment_refunds (reference,request_key,order_id,payment_id,amount,method,reason,status,requested_by,processed_by,processed_at) values ($1,$2,$3,$4,$5,'Cash','Payment report adjustment',$6,$7,case when $6='Processed' then $7::uuid else null end,case when $6='Processed' then now() else null end) returning id`,
    [`CP-REF-${randomUUID()}`, randomUUID(), orderId, paymentId, amount, status, actorId],
  )
}

beforeAll(async () => {
  for (const key of ['payments.read', 'payments.create', 'audit.read'])
    await pool.query(
      'insert into permissions (key,description) values ($1,$1) on conflict do nothing',
      [key],
    )
  branchId = await insertId('insert into branches (name,code) values ($1,$2) returning id', [
    `Customer payment branch ${fixture}`,
    `cp-${fixture}`,
  ])
  otherBranchId = await insertId('insert into branches (name,code) values ($1,$2) returning id', [
    `Other payment branch ${fixture}`,
    `cpo-${fixture}`,
  ])
  actorId = await account('operator', branchId, ['payments.read', 'payments.create', 'audit.read'])
  await account('reader', branchId, ['payments.read'])
  await account('denied', branchId, [])
  await account('other', otherBranchId, ['payments.read', 'payments.create'])
  await account('unassigned', null, ['payments.read', 'payments.create'])
  customerId = await insertId(
    'insert into customers (name, branch_id) values ($1, $2) returning id',
    [`Customer payment customer ${fixture}`, branchId],
  )
  productId = await insertId(
    "insert into products (name,sku,category,unit,unit_price) values ($1,$2,'Materials','piece','100.00') returning id",
    [`Customer payment product ${fixture}`, `CPP-${fixture}`],
  )
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Payment test server did not listen.')
  apiUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  await pool.end()
})

describe('customer payment transaction views and receipts', () => {
  it('enforces authentication, payment permission, and real branch scope without needing sales.read', async () => {
    const order = await makeOrder()
    expect((await request('GET', `/payments/orders/${order.id}`)).status).toBe(401)
    expect((await request('GET', `/payments/orders/${order.id}`, 'denied')).status).toBe(403)
    expect((await request('GET', `/payments/orders/${order.id}`, 'other')).status).toBe(404)
    expect((await request('GET', `/payments/orders/${order.id}`, 'unassigned')).status).toBe(403)
    expect((await request('GET', '/payments/orders/invalid', 'reader')).status).toBe(400)
    const detail = await request<Detail>('GET', `/payments/orders/${order.id}`, 'reader')
    expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({
      balance: '100.00',
      netPaidAmount: '0.00',
      paymentStatus: 'Unpaid',
      payments: [],
      history: [],
      canRecordPayment: false,
    })
    expect(
      (
        await request('POST', '/payments', 'reader', {
          orderId: order.id,
          amount: '1.00',
          method: 'Cash',
        })
      ).status,
    ).toBe(403)
  })

  it('shows unpaid orders directly and uses monetary rather than lexical sorting', async () => {
    const small = await makeOrder('9.00')
    const large = await makeOrder('1000.00')
    await makeOrder('2000.00', otherBranchId)
    const list = await request<List>(
      'GET',
      `/payments?search=CP-${fixture}&sort=Remaining%20Balance&order=asc&limit=100`,
      'reader',
    )
    expect(list.status).toBe(200)
    const ids = list.body.data.map((row) => row.id)
    expect(ids.indexOf(small.id)).toBeLessThan(ids.indexOf(large.id))
    expect(list.body.data.find((row) => row.id === large.id)).toMatchObject({
      Order: large.number,
      'Total Amount': '₱1,000.00',
      'Amount Paid': '₱0.00',
      'Remaining Balance': '₱1,000.00',
      Status: 'Unpaid',
      'Last Payment Date': '—',
    })
    expect(list.body.data.some((row) => row['Total Amount'] === '₱2,000.00')).toBe(false)
    const paged = await request<List>(
      'GET',
      `/payments?search=${large.number}&limit=1&page=1&status=Unpaid`,
      'reader',
    )
    expect(paged.body.total).toBe(1)
    expect(paged.body.data[0]?.id).toBe(large.id)
  })

  it('keeps partial receipts with their own date/reference/notes and derives paid status', async () => {
    const order = await makeOrder()
    const first = await pay(order.id, '30.00', {
      requestKey: randomUUID(),
      method: 'GCash',
      paymentDate: '2020-09-01',
      externalReference: 'GCash-first',
      notes: 'First installment',
    })
    expect(first.status).toBe(201)
    expect(first.body.remainingBalance).toBe('70.00')
    const second = await pay(order.id, '20.00', {
      paymentDate: '2020-09-10',
      externalReference: 'cash-20',
    })
    expect(second.status).toBe(201)
    const partial = await request<Detail>('GET', `/payments/orders/${order.id}`, 'operator')
    expect(partial.body).toMatchObject({
      paymentsAmount: '50.00',
      netPaidAmount: '50.00',
      balance: '50.00',
      paymentStatus: 'Partially Paid',
      canRecordPayment: true,
    })
    const last = await pay(order.id, '50.00', {
      method: 'Bank transfer',
      paymentDate: '2020-09-20',
      externalReference: 'bank-final',
    })
    expect(last.status).toBe(201)
    const detail = await request<Detail>('GET', `/payments/orders/${order.id}`, 'operator')
    expect(detail.body).toMatchObject({
      balance: '0.00',
      paymentStatus: 'Paid',
      canRecordPayment: false,
    })
    expect(detail.body.payments).toHaveLength(3)
    expect(detail.body.payments.find((payment) => payment.id === first.body.id)).toMatchObject({
      amount: '30.00',
      paymentDate: '2020-09-01',
      externalReference: 'GCash-first',
      notes: 'First installment',
    })
    expect(detail.body.history.filter((entry) => entry.action === 'recorded payment')).toHaveLength(
      3,
    )
    const list = await request<List>(
      'GET',
      `/payments?search=${order.number}&status=Paid`,
      'reader',
    )
    expect(list.body.data[0]).toMatchObject({
      'Amount Paid': '₱100.00',
      'Remaining Balance': '₱0.00',
      Status: 'Paid',
      'Last Payment Date': 'Sep 20, 2020',
    })
    expect(
      (await request('PATCH', `/payments/${first.body.id}`, 'operator', { amount: '1.00' })).status,
    ).toBe(404)
  })

  it('serializes identical retries and rejects a reused key with changed details', async () => {
    const order = await makeOrder()
    const requestKey = randomUUID()
    const results = await Promise.all([
      pay(order.id, '30.00', { requestKey }),
      pay(order.id, '30.00', { requestKey }),
    ])
    expect(results.map((result) => result.status)).toEqual([201, 201])
    expect(results[0].body.id).toBe(results[1].body.id)
    const changed = await pay(order.id, '20.00', { requestKey })
    expect(changed.status).toBe(409)
    expect((changed.body as unknown as ErrorBody).error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    const detail = await request<Detail>('GET', `/payments/orders/${order.id}`, 'operator')
    expect(detail.body.payments).toHaveLength(1)
    expect(detail.body.balance).toBe('70.00')
    const otherOrder = await makeOrder()
    expect((await pay(otherOrder.id, '30.00', { requestKey })).status).toBe(409)
  })

  it('replays final receipt retries even after no balance remains or the order closes', async () => {
    const order = await makeOrder()
    const requestKey = randomUUID()
    const first = await pay(order.id, '100.00', { requestKey })
    await pool.query("update orders set status='Completed' where id=$1", [order.id])
    const replay = await pay(order.id, '100.00', { requestKey })
    expect(replay.status).toBe(201)
    expect(replay.body.id).toBe(first.body.id)
    expect((await pay(order.id, '1.00')).status).toBe(409)
  })

  it('rejects concurrent excessive payments and invalid metadata on the server', async () => {
    const order = await makeOrder('0.03')
    const results = await Promise.all([
      pay(order.id, '0.02', { requestKey: randomUUID() }),
      pay(order.id, '0.02', { requestKey: randomUUID() }),
    ])
    expect(results.map((result) => result.status).sort()).toEqual([201, 409])
    expect((await pay(order.id, '-1.00')).status).toBe(400)
    expect((await pay(order.id, '0.001')).status).toBe(400)
    expect((await pay(order.id, '0.01', { paymentDate: '9999-12-31' })).status).toBe(400)
    expect((await pay(order.id, '0.01', { externalReference: 'x'.repeat(201) })).status).toBe(400)
    const detail = await request<Detail>('GET', `/payments/orders/${order.id}`, 'operator')
    expect(detail.body).toMatchObject({ netPaidAmount: '0.02', balance: '0.01' })
  })

  it('shows refunds separately without double-counting cancelled contractual value', async () => {
    const order = await makeOrder()
    const payment = await pay(order.id, '100.00')
    await refund(order.id, payment.body.id, '40.00', 'Processed')
    await pool.query("update order_items set cancelled_quantity='0.4' where order_id=$1", [
      order.id,
    ])
    const detail = await request<Detail>('GET', `/payments/orders/${order.id}`, 'operator')
    expect(detail.body).toMatchObject({
      payableAmount: '60.00',
      paymentsAmount: '100.00',
      refundedAmount: '40.00',
      netPaidAmount: '60.00',
      balance: '0.00',
      paymentStatus: 'Paid',
    })
    expect(detail.body.payments).toEqual([expect.objectContaining({ amount: '100.00' })])
  })

  it('preserves historical overpayment and cancelled statuses rather than hiding anomalies', async () => {
    const order = await makeOrder('10.00')
    await pool.query(
      "insert into payments (reference,order_id,method,amount,recorded_by) values ($1,$2,'Cash','20.00',$3)",
      [`CP-OVER-${fixture}`, order.id, actorId],
    )
    const overpaid = await request<Detail>('GET', `/payments/orders/${order.id}`, 'reader')
    expect(overpaid.body).toMatchObject({ balance: '-10.00', paymentStatus: 'Overpaid' })
    const cancelled = await makeOrder('10.00', branchId, 'Cancelled')
    await pool.query('update order_items set cancelled_quantity=quantity where order_id=$1', [
      cancelled.id,
    ])
    const list = await request<List>('GET', `/payments?search=${cancelled.number}`, 'reader')
    expect(list.body.data[0]).toMatchObject({ Status: 'Cancelled', 'Remaining Balance': '₱0.00' })
  })

  it('blocks new receipts while requested refunds are unresolved', async () => {
    const order = await makeOrder()
    const payment = await pay(order.id, '30.00')
    await refund(order.id, payment.body.id, '5.00', 'Requested')
    const result = await pay(order.id, '1.00')
    expect(result.status).toBe(409)
    expect((result.body as unknown as ErrorBody).error.code).toBe('REFUND_PENDING')
    const detail = await request<Detail>('GET', `/payments/orders/${order.id}`, 'operator')
    expect(detail.body.canRecordPayment).toBe(false)
    const options = await request<{ id: string }[]>('GET', '/payments/options', 'operator')
    expect(options.body.some((option) => option.id === order.id)).toBe(false)
  })

  it('reports actual receipt dates and current balances with customer/status and branch filters', async () => {
    const order = await makeOrder('10.00')
    await pay(order.id, '4.00', {
      paymentDate: '2019-03-01',
      method: 'GCash',
      externalReference: 'report-date-proof',
    })
    const input = { dateFrom: '2019-03-01', dateTo: '2019-03-01', customerId }
    const history = await queryCustomerPaymentReport(
      { ...input, report: 'customer-payment-history' },
      branchId,
    )
    expect(
      history.rows.some(
        (row) =>
          row.Order === order.number &&
          row['Amount (PHP)'] === '4.00' &&
          row['Payment date'] === '2019-03-01',
      ),
    ).toBe(true)
    const excluded = await queryCustomerPaymentReport(
      {
        ...input,
        report: 'customer-payment-history',
        dateFrom: '2019-03-02',
        dateTo: '2019-03-02',
      },
      branchId,
    )
    expect(excluded.rows).toHaveLength(0)
    const balances = await queryCustomerPaymentReport(
      { ...input, report: 'customer-balances', status: 'Partially Paid' },
      branchId,
    )
    expect(balances.rows.find((row) => row.Order === order.number)).toMatchObject({
      'Balance (PHP)': '6.00',
    })
    const other = await queryCustomerPaymentReport(
      { ...input, report: 'customer-payment-history' },
      otherBranchId,
    )
    expect(other.rows).toHaveLength(0)
    const summary = await getCustomerBalanceSummary(branchId)
    expect(summary.outstandingOrders).toBeGreaterThan(0)
    expect(summary.outstandingBalance.startsWith('-')).toBe(false)
  })
})
