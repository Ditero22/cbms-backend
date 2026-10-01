import type { PoolClient } from 'pg'
import { pool } from '@/database/client.js'
import { orderPaymentAmountsSql } from './payment-balances.sql.js'
import { remainingOrderValueSql } from '@/features/orders/order-value.sql.js'

export async function getPaymentOptions(branchId?: string | null) {
  const result = await pool.query<{
    id: string
    orderNumber: string
    customerName: string
    branchId: string
    totalAmount: string
    paidAmount: string
    balance: string
  }>(
    `select financial.id::text as id,
           financial.order_number as "orderNumber",
           c.name as "customerName",
           financial.branch_id::text as "branchId",
           financial.payable_amount::text as "totalAmount",
           financial.net_paid_amount::text as "paidAmount",
           financial.balance::text as balance
      from (${orderPaymentAmountsSql}) financial
      join customers c on c.id = financial.customer_id
     where financial.status not in ('Cancelled', 'Completed')
       and ($1::uuid is null or financial.branch_id = $1)
       and financial.pending_refund_amount = 0 and financial.balance > 0
     order by financial.created_at desc`,
    [branchId ?? null],
  )
  return result.rows
}

export async function findOrderForUpdate(client: PoolClient, orderId: string) {
  const result = await client.query<{
    id: string
    branchId: string
    totalAmount: string
    payableAmount: string
    status: string
  }>(
    `select o.id::text as id, o.branch_id::text as "branchId", o.total_amount::text as "totalAmount",
            ${remainingOrderValueSql}::text as "payableAmount",
            o.status
       from orders o where o.id = $1 for update`,
    [orderId],
  )
  return result.rows[0]
}

export async function getPaidAmount(client: PoolClient, orderId: string) {
  const result = await client.query<{ paidAmount: string }>(
    'select coalesce(sum(amount), 0)::text as "paidAmount" from payments where order_id = $1 and status = \'Paid\'',
    [orderId],
  )
  return result.rows[0]?.paidAmount ?? '0.00'
}

export async function getRefundTotals(client: PoolClient, orderId: string) {
  const result = await client.query<{ processed: string; pending: string }>(
    `select coalesce(sum(amount) filter (where status = 'Processed'), 0)::text as processed,
            coalesce(sum(amount) filter (where status in ('Requested', 'Approved')), 0)::text as pending
       from payment_refunds where order_id = $1`,
    [orderId],
  )
  return result.rows[0] ?? { processed: '0.00', pending: '0.00' }
}

export async function insertPayment(
  client: PoolClient,
  values: {
    reference: string
    orderId: string
    method: string
    amount: string
    recordedBy: string
    paymentDate: string
    externalReference: string | null
    notes: string | null
    requestKey: string | null
    requestFingerprint: string | null
  },
) {
  const result = await client.query<{ id: string }>(
    `insert into payments (reference, order_id, method, amount, status, recorded_by,
                          payment_date, external_reference, notes, request_key, request_fingerprint)
     values ($1, $2, $3, $4, 'Paid', $5, $6, $7, $8, $9, $10) returning id`,
    [
      values.reference,
      values.orderId,
      values.method,
      values.amount,
      values.recordedBy,
      values.paymentDate,
      values.externalReference,
      values.notes,
      values.requestKey,
      values.requestFingerprint,
    ],
  )
  return result.rows[0]?.id
}

export async function insertPaymentAuditLog(
  client: PoolClient,
  values: {
    userId: string
    branchId: string
    paymentId: string
    paymentReference: string
    orderId: string
    amount: string
    method: string
    paymentDate: string
    externalReference: string | null
    notes: string | null
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    `insert into audit_logs (user_id, branch_id, action, entity_type, entity_id, new_value, ip_address, request_id)
     values ($1, $2, 'recorded payment', 'payment', $3, $4, $5, $6)`,
    [
      values.userId,
      values.branchId,
      values.paymentId,
      {
        reference: values.paymentReference,
        orderId: values.orderId,
        amount: values.amount,
        method: values.method,
        paymentDate: values.paymentDate,
        externalReference: values.externalReference,
        notes: values.notes,
      },
      values.ipAddress,
      values.requestId,
    ],
  )
}

export async function lockPaymentRequestKey(client: PoolClient, key: string) {
  // Serialize retries, including accidental reuse against a different order.
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `customer-payment:${key}`,
  ])
}

export async function findPaymentByRequestKey(client: PoolClient, key: string) {
  const result = await client.query<{
    id: string
    reference: string
    orderId: string
    recordedBy: string
    amount: string
    method: string
    paymentDate: string
    externalReference: string | null
    notes: string | null
    requestFingerprint: string | null
    proofAttachmentId: string | null
  }>(
    `select id::text as id, reference, order_id::text as "orderId", recorded_by::text as "recordedBy",
            amount::text as amount, method, payment_date::text as "paymentDate",
            external_reference as "externalReference", notes, request_fingerprint as "requestFingerprint",
            payment_proof_attachment_id::text as "proofAttachmentId" from payments where request_key = $1`,
    [key],
  )
  return result.rows[0]
}
