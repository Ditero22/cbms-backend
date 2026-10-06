import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { pool } from '@/database/client.js'
import { authorizeProof } from '@/features/attachments/attachment.service.js'
import { placeOrder, getOrderDetail } from '@/features/orders/order.service.js'
import * as orderRepository from '@/features/orders/order.repository.js'
import { getOrderLifecycleEligibility } from '@/features/orders/order-lifecycle.service.js'
import { recordPayment } from '@/features/payments/payment.service.js'
import { approveRefund, processRefund, requestRefund } from '@/features/payments/refund.service.js'
import { createDelivery, updateDeliveryStatus } from '@/features/deliveries/delivery.service.js'
import { approveReturn, receiveReturn, requestReturn } from '@/features/orders/return.service.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

let branchId: string
let customerId: string
let productId: string
let userId: string
let user: AuthenticatedUser

async function insertId(query: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(query, values)
  const id = result.rows[0]?.id
  if (!id) throw new Error('An order concurrency fixture could not be created.')
  return id
}

function refundContext() {
  return { user, ipAddress: null, requestId: null }
}

function orderContext() {
  return { userId, customerBranchScope: branchId, ipAddress: null, requestId: null }
}

function scopedContext() {
  return { ...orderContext(), branchId, isCrossBranch: false }
}

async function makeOrder() {
  const order = await placeOrder(
    { customerId, branchId, items: [{ productId, quantity: 2 }] },
    orderContext(),
  )
  const item = await pool.query<{ id: string }>(
    'select id::text as id from order_items where order_id = $1',
    [order.id],
  )
  const itemId = item.rows[0]?.id
  if (!itemId) throw new Error('The order item could not be found.')
  return { orderId: order.id, itemId }
}

async function payOrder(orderId: string) {
  return recordPayment({ orderId, amount: '20.00', method: 'Cash' }, scopedContext())
}

async function deliverOrder(orderId: string, itemId: string) {
  const delivery = await createDelivery(
    {
      orderId,
      destination: 'Concurrency test site',
      items: [{ orderItemId: itemId, quantity: '2' }],
    },
    scopedContext(),
  )
  await updateDeliveryStatus(delivery.id, 'In Transit', scopedContext())
  await updateDeliveryStatus(delivery.id, 'Delivered', scopedContext())
  return delivery.id
}

beforeAll(async () => {
  const fixture = randomUUID().slice(0, 8)
  const roleId = await insertId('insert into roles (name) values ($1) returning id', [
    `Order concurrency ${fixture}`,
  ])
  branchId = await insertId('insert into branches (name, code) values ($1, $2) returning id', [
    `Concurrency branch ${fixture}`,
    `con-${fixture}`,
  ])
  userId = await insertId(
    `insert into users (email, name, password_hash, role_id, branch_id, status)
     values ($1, 'Concurrency actor', 'unused-test-hash', $2, $3, 'Active') returning id`,
    [`concurrency-${fixture}@example.invalid`, roleId, branchId],
  )
  customerId = await insertId(
    'insert into customers (name, branch_id) values ($1, $2) returning id',
    [`Concurrency customer ${fixture}`, branchId],
  )
  productId = await insertId(
    `insert into products (name, sku, category, unit, unit_price)
     values ($1, $2, 'Materials', 'piece', '10.00') returning id`,
    [`Concurrency product ${fixture}`, `CON-${fixture}`],
  )
  await pool.query('insert into inventory (product_id, branch_id, quantity) values ($1, $2, $3)', [
    productId,
    branchId,
    '20.000',
  ])
  user = {
    id: userId,
    name: 'Concurrency actor',
    email: `concurrency-${fixture}@example.invalid`,
    role: `Order concurrency ${fixture}`,
    branchId,
    branch: `Concurrency branch ${fixture}`,
    isCrossBranch: false,
    permissions: [
      'sales.read',
      'payments.refund.request',
      'payments.refund.approve',
      'payments.refund.process',
      'returns.create',
      'returns.approve',
      'returns.receive',
    ],
  }
})

afterAll(async () => {
  await pool.end()
})

describe('order, refund, and return persistence', () => {
  it('proof authorization waits for the order before locking its delivery', async () => {
    const { orderId, itemId } = await makeOrder()
    const delivery = await createDelivery(
      {
        orderId,
        destination: 'Concurrent proof site',
        items: [{ orderItemId: itemId, quantity: '1' }],
      },
      scopedContext(),
    )
    const lifecycle = await pool.connect()
    const proof = await pool.connect()
    let proofResult: Promise<unknown> | undefined
    try {
      await lifecycle.query('begin')
      await proof.query('begin')
      await proof.query("set local statement_timeout = '5s'")
      await lifecycle.query('select id from orders where id=$1 for update', [orderId])
      const pid = (await proof.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!
        .pid
      proofResult = authorizeProof(
        { entityType: 'delivery', entityId: delivery.id },
        {
          ...user,
          permissions: ['deliveries.read', 'deliveries.update'],
        },
        true,
        proof,
        true,
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      await expect
        .poll(async () => {
          const locks = await pool.query<{ waiting: boolean }>(
            'select cardinality(pg_blocking_pids($1)) > 0 as waiting',
            [pid],
          )
          return locks.rows[0]!.waiting
        })
        .toBe(true)
      // Lifecycle writers lock order, then delivery. A waiting proof must not hold delivery first.
      await expect(
        lifecycle.query('select id from deliveries where id=$1 for update nowait', [delivery.id]),
      ).resolves.toMatchObject({ rowCount: 1 })
      await lifecycle.query('commit')
      await expect(proofResult).resolves.toMatchObject({ value: { branchId } })
    } finally {
      await lifecycle.query('rollback')
      if (proofResult) await proofResult
      await proof.query('rollback')
      lifecycle.release()
      proof.release()
    }
  })

  it('keeps order financial detail and lifecycle consistent across concurrent payment and refund commits', async () => {
    const { orderId } = await makeOrder()
    const reader = { ...user, permissions: [...user.permissions, 'audit.read'] }
    async function readAcrossCommit(commit: () => Promise<unknown>) {
      const readDetail = orderRepository.getOrderDetail
      const intercepted = vi
        .spyOn(orderRepository, 'getOrderDetail')
        .mockImplementationOnce(async (...args) => {
          const detail = await readDetail(...args)
          // Commit on another connection between the detail collections and eligibility read.
          await commit()
          return detail
        })
      try {
        return await getOrderDetail(orderId, reader)
      } finally {
        intercepted.mockRestore()
      }
    }

    const beforePayment = await readAcrossCommit(() => payOrder(orderId))
    expect(beforePayment.payments).toEqual([])
    expect(beforePayment.paidAmount).toBe('0.00')
    expect(beforePayment.balance).toBe('20.00')
    expect(beforePayment.lifecycle.financial).toMatchObject({ netPaid: '0.00', balance: '20.00' })
    expect(beforePayment.history.some((entry) => entry.action === 'recorded payment')).toBe(false)

    const afterPayment = await getOrderDetail(orderId, reader)
    expect(afterPayment.paidAmount).toBe('20.00')
    expect(afterPayment.lifecycle.financial).toMatchObject({ netPaid: '20.00', balance: '0.00' })
    const refund = await requestRefund(
      orderId,
      {
        requestKey: randomUUID(),
        paymentId: afterPayment.payments[0]!.id,
        amount: '20.00',
        method: 'Cash',
        reason: 'Snapshot concurrency verification',
      },
      refundContext(),
    )
    await approveRefund(refund.id, refundContext())

    const beforeRefund = await readAcrossCommit(() =>
      processRefund(refund.id, undefined, refundContext()),
    )
    expect(beforeRefund.refunds).toMatchObject([{ id: refund.id, status: 'Approved' }])
    expect(beforeRefund.paidAmount).toBe('20.00')
    expect(beforeRefund.lifecycle.financial).toMatchObject({ netPaid: '20.00', balance: '0.00' })
    expect(beforeRefund.history.some((entry) => entry.action === 'processed payment refund')).toBe(
      false,
    )

    const afterRefund = await getOrderDetail(orderId, reader)
    expect(afterRefund.refunds).toMatchObject([{ id: refund.id, status: 'Processed' }])
    expect(afterRefund.paidAmount).toBe('0.00')
    expect(afterRefund.balance).toBe('20.00')
    expect(afterRefund.lifecycle.financial).toMatchObject({ netPaid: '0.00', balance: '20.00' })
  })

  it('replays one committed order exactly once and rejects changed intent', async () => {
    const requestKey = randomUUID()
    const input = {
      customerId,
      branchId,
      items: [{ productId, quantity: 2.375 }],
      requestKey,
    }
    const [first, replay] = await Promise.all([
      placeOrder(input, orderContext()),
      placeOrder(input, orderContext()),
    ])
    expect(replay).toEqual(first)

    const counts = await pool.query<{
      orders: string
      items: string
      reservations: string
      movements: string
      audits: string
    }>(
      `select count(distinct o.id)::text as orders, count(distinct oi.id)::text as items,
              count(distinct r.id)::text as reservations, count(distinct it.id)::text as movements,
              count(distinct a.id)::text as audits
         from orders o
         left join order_items oi on oi.order_id = o.id
         left join order_reservations r on r.order_item_id = oi.id
         left join inventory_transactions it on it.reference_type = 'Order' and it.reference_id = o.id
         left join audit_logs a on a.entity_type = 'order' and a.entity_id = o.id
        where o.request_key = $1`,
      [requestKey],
    )
    expect(counts.rows[0]).toEqual({
      orders: '1',
      items: '1',
      reservations: '1',
      movements: '1',
      audits: '1',
    })

    await expect(
      placeOrder({ ...input, items: [{ productId, quantity: 2.5 }] }, orderContext()),
    ).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' })
    await expect(
      placeOrder(input, { ...orderContext(), userId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' })

    const before = await pool.query<{ reserved: string }>(
      'select reserved_quantity::text as reserved from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    await pool.query("update customers set status = 'Inactive' where id = $1", [customerId])
    try {
      expect(await placeOrder(input, orderContext())).toEqual(first)
    } finally {
      await pool.query("update customers set status = 'Active' where id = $1", [customerId])
    }
    const after = await pool.query<{ reserved: string }>(
      'select reserved_quantity::text as reserved from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    expect(after.rows[0]?.reserved).toBe(before.rows[0]?.reserved)
  })

  it('does not consume an order key when stock validation rolls back', async () => {
    const requestKey = randomUUID()
    const input = {
      customerId,
      branchId,
      items: [{ productId, quantity: 1_000_000 }],
      requestKey,
    }
    await expect(placeOrder(input, orderContext())).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
    })
    const created = await placeOrder(
      { ...input, items: [{ productId, quantity: 1 }] },
      orderContext(),
    )
    expect(created.itemCount).toBe(1)
    const saved = await pool.query<{ count: string }>(
      'select count(*)::text as count from orders where request_key = $1',
      [requestKey],
    )
    expect(saved.rows[0]?.count).toBe('1')
  })

  it('serializes different refund keys against one payment and deduplicates identical replay', async () => {
    const { orderId } = await makeOrder()
    const payment = await payOrder(orderId)
    const request = (requestKey: string, amount = '15.00') =>
      requestRefund(
        orderId,
        {
          requestKey,
          paymentId: payment.id,
          amount,
          method: 'Cash',
          reason: 'Concurrent adjustment',
        },
        refundContext(),
      )
    const requestKeys = [randomUUID(), randomUUID()]
    const competing = await Promise.allSettled(requestKeys.map((key) => request(key)))
    const successful = competing.filter((result) => result.status === 'fulfilled')
    const denied = competing.filter((result) => result.status === 'rejected')
    if (successful.length === 0) {
      throw new Error(
        `Both refund requests failed: ${denied.map((result) => (result.status === 'rejected' ? String(result.reason) : 'fulfilled')).join('; ')}`,
      )
    }
    expect(successful).toHaveLength(1)
    expect(denied).toHaveLength(1)
    if (successful[0]?.status !== 'fulfilled' || denied[0]?.status !== 'rejected') {
      throw new Error('Unexpected refund race result.')
    }
    expect(denied[0].reason).toMatchObject({ code: 'REFUND_EXCEEDS_PAYMENT' })
    const firstRefundId = successful[0].value.id
    const replayKey = randomUUID()
    const replay = await Promise.all([request(replayKey, '5.00'), request(replayKey, '5.00')])
    expect(replay[0]?.id).toBe(replay[1]?.id)
    const stored = await pool.query<{ id: string; amount: string; status: string }>(
      `select id::text as id, amount::text as amount, status from payment_refunds
       where payment_id = $1 order by payment_refunds.amount desc`,
      [payment.id],
    )
    expect(stored.rows).toMatchObject([
      { id: firstRefundId, amount: '15.00', status: 'Requested' },
      { id: replay[0]?.id, amount: '5.00', status: 'Requested' },
    ])
    const audit = await pool.query<{ count: string }>(
      `select count(*)::text as count from audit_logs
       where entity_type = 'payment_refund' and action = 'requested payment refund'
         and entity_id in ($1, $2)`,
      [firstRefundId, replay[0]?.id],
    )
    expect(audit.rows[0]?.count).toBe('2')
    const original = await pool.query<{ amount: string; status: string }>(
      'select amount::text as amount, status from payments where id = $1',
      [payment.id],
    )
    expect(original.rows[0]).toEqual({ amount: '20.00', status: 'Paid' })

    await approveRefund(firstRefundId, refundContext())
    const processed = await Promise.allSettled([
      processRefund(firstRefundId, 'CONCURRENT-REFUND-01', refundContext()),
      processRefund(firstRefundId, 'CONCURRENT-REFUND-01', refundContext()),
    ])
    expect(processed.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const failedProcess = processed.find((result) => result.status === 'rejected')
    if (failedProcess?.status !== 'rejected') throw new Error('Both refund posts succeeded.')
    expect(failedProcess.reason).toMatchObject({ code: 'REFUND_NOT_APPROVED' })
    const posted = await pool.query<{ status: string; processed_reference: string }>(
      'select status, processed_reference from payment_refunds where id = $1',
      [firstRefundId],
    )
    expect(posted.rows[0]).toEqual({
      status: 'Processed',
      processed_reference: 'CONCURRENT-REFUND-01',
    })
    const processedAudit = await pool.query<{ count: string }>(
      `select count(*)::text as count from audit_logs
       where entity_type = 'payment_refund' and entity_id = $1 and action = 'processed payment refund'`,
      [firstRefundId],
    )
    expect(processedAudit.rows[0]?.count).toBe('1')
    const detail = await getOrderDetail(orderId, user)
    expect(detail.paidAmount).toBe('5.00')
    expect(detail.balance).toBe('15.00')
    expect(detail.payments).toMatchObject([{ id: payment.id, amount: '20.00', status: 'Paid' }])
  })

  it('serializes returns against delivered quantity and posts one stock receipt', async () => {
    const { orderId, itemId } = await makeOrder()
    const deliveryId = await deliverOrder(orderId, itemId)
    const payment = await payOrder(orderId)
    const request = (requestKey: string) =>
      requestReturn(
        orderId,
        {
          requestKey,
          deliveryId,
          reason: 'Concurrent material return',
          items: [{ orderItemId: itemId, quantity: '2' }],
        },
        refundContext(),
      )
    const requestKeys = [randomUUID(), randomUUID()]
    const competing = await Promise.allSettled(requestKeys.map(request))
    const successful = competing.filter((result) => result.status === 'fulfilled')
    const denied = competing.filter((result) => result.status === 'rejected')
    expect(successful).toHaveLength(1)
    expect(denied).toHaveLength(1)
    if (successful[0]?.status !== 'fulfilled' || denied[0]?.status !== 'rejected') {
      throw new Error('Unexpected return race result.')
    }
    expect(denied[0].reason).toMatchObject({ code: 'RETURN_EXCEEDS_DELIVERED_QUANTITY' })
    const returnId = successful[0].value.id
    const winningIndex = competing.findIndex((result) => result.status === 'fulfilled')
    const replayKey = requestKeys[winningIndex]
    if (!replayKey) throw new Error('The winning return key was not recorded.')
    const replay = await Promise.all([request(replayKey), request(replayKey)])
    expect(replay[0]?.id).toBe(replay[1]?.id)
    const count = await pool.query<{ count: string }>(
      'select count(*)::text as count from order_returns where order_id = $1',
      [orderId],
    )
    expect(count.rows[0]?.count).toBe('1')
    expect(replay[0]?.id).toBe(returnId)
    const requestAudit = await pool.query<{ count: string }>(
      `select count(*)::text as count from audit_logs
       where entity_type = 'order_return' and entity_id = $1 and action = 'requested order return'`,
      [returnId],
    )
    expect(requestAudit.rows[0]?.count).toBe('1')

    await approveReturn(returnId, refundContext())
    const stockBefore = await pool.query<{ quantity: string }>(
      'select quantity::text as quantity from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    const classification = {
      items: [{ orderItemId: itemId, condition: 'Resalable', acceptedQuantity: '2' }],
    }
    const received = await Promise.allSettled([
      receiveReturn(returnId, classification, refundContext()),
      receiveReturn(returnId, classification, refundContext()),
    ])
    expect(received.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const failedReceive = received.find((result) => result.status === 'rejected')
    if (failedReceive?.status !== 'rejected') throw new Error('Both stock receipts succeeded.')
    expect(failedReceive.reason).toMatchObject({ code: 'RETURN_NOT_APPROVED' })
    const stockAfter = await pool.query<{ quantity: string }>(
      'select quantity::text as quantity from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    expect(Number(stockAfter.rows[0]?.quantity)).toBe(Number(stockBefore.rows[0]?.quantity) + 2)
    const movements = await pool.query<{ quantityDelta: string }>(
      `select quantity_delta::text as "quantityDelta"
       from inventory_transactions where reference_type = 'OrderReturn' and reference_id = $1`,
      [returnId],
    )
    expect(movements.rows).toEqual([{ quantityDelta: '2.000' }])
    const receivedAudit = await pool.query<{ count: string }>(
      `select count(*)::text as count from audit_logs
       where entity_type = 'order_return' and entity_id = $1 and action = 'received order return'`,
      [returnId],
    )
    expect(receivedAudit.rows[0]?.count).toBe('1')
    const saved = await pool.query<{ status: string; acceptedQuantity: string }>(
      `select r.status, ri.accepted_quantity::text as "acceptedQuantity"
       from order_returns r join order_return_items ri on ri.return_id = r.id where r.id = $1`,
      [returnId],
    )
    expect(saved.rows[0]).toEqual({ status: 'Received', acceptedQuantity: '2.000' })
    const detail = await getOrderDetail(orderId, user)
    expect(detail.paidAmount).toBe('20.00')
    expect(detail.balance).toBe('0.00')
    expect(detail.payments).toMatchObject([{ id: payment.id, amount: '20.00', status: 'Paid' }])
  })

  it('formats a legacy overpayment as a signed negative balance', async () => {
    const { orderId } = await makeOrder()
    await pool.query(
      `insert into payments (reference, order_id, method, amount, status, recorded_by)
       values ($1, $2, 'Cash', '30.00', 'Paid', $3)`,
      [`LEGACY-OVERPAY-${randomUUID()}`, orderId, userId],
    )
    const detail = await getOrderDetail(orderId, user)
    expect(detail.payableAmount).toBe('20.00')
    expect(detail.paidAmount).toBe('30.00')
    expect(detail.balance).toBe('-10.00')
    const eligibility = await getOrderLifecycleEligibility(orderId, user)
    expect(eligibility.financial.balance).toBe('-10.00')
    expect(eligibility.financial.paymentStatus).toBe('Overpaid')
  })
})
