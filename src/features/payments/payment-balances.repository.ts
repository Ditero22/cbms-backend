import { pool } from '@/database/client.js'
import type { PoolClient } from 'pg'
import { orderPaymentAmountsSql, paymentStatusSql } from './payment-balances.sql.js'

export async function getCustomerPaymentOrder(
  orderId: string,
  branchId?: string,
  client?: PoolClient,
) {
  const result = await (client ?? pool).query<{
    id: string
    orderNumber: string
    customerId: string
    customerName: string
    branchId: string
    branchName: string
    originalTotal: string
    payableAmount: string
    paymentsAmount: string
    refundedAmount: string
    netPaidAmount: string
    balance: string
    pendingRefundAmount: string
    paymentStatus: string
    orderStatus: string
    lastPaymentDate: string | null
  }>(
    `select financial.id::text as id, financial.order_number as "orderNumber",
            financial.customer_id::text as "customerId", c.name as "customerName",
            financial.branch_id::text as "branchId", b.name as "branchName",
            round(financial.original_total, 2)::text as "originalTotal",
            round(financial.payable_amount, 2)::text as "payableAmount",
            round(financial.payments_amount, 2)::text as "paymentsAmount",
            round(financial.refunded_amount, 2)::text as "refundedAmount",
            round(financial.net_paid_amount, 2)::text as "netPaidAmount",
            round(financial.balance, 2)::text as balance,
            round(financial.pending_refund_amount, 2)::text as "pendingRefundAmount",
            ${paymentStatusSql} as "paymentStatus", financial.status as "orderStatus",
            financial.last_payment_date::text as "lastPaymentDate"
       from (${orderPaymentAmountsSql}) financial
       join customers c on c.id = financial.customer_id
       join branches b on b.id = financial.branch_id
      where financial.id = $1 and ($2::uuid is null or financial.branch_id = $2)`,
    [orderId, branchId ?? null],
  )
  return result.rows[0]
}

export async function getCustomerPaymentHistory(orderId: string, client?: PoolClient) {
  const result = await (client ?? pool).query<{
    id: string
    reference: string
    amount: string
    method: string
    status: string
    paymentDate: string
    externalReference: string | null
    notes: string | null
    recordedByName: string
    createdAt: Date
  }>(
    `select p.id::text as id, p.reference, p.amount::text as amount, p.method, p.status,
            p.payment_date::text as "paymentDate", p.external_reference as "externalReference",
            p.notes, u.name as "recordedByName", p.created_at as "createdAt"
       from payments p join users u on u.id = p.recorded_by
      where p.order_id = $1 order by p.payment_date desc, p.created_at desc, p.id desc`,
    [orderId],
  )
  return result.rows
}

export async function getCustomerRefundHistory(orderId: string, client?: PoolClient) {
  const result = await (client ?? pool).query<{
    id: string
    reference: string
    paymentId: string
    amount: string
    status: string
    processedAt: Date | null
    processedReference: string | null
  }>(
    `select id::text as id, reference, payment_id::text as "paymentId", amount::text as amount,
            status, processed_at as "processedAt", processed_reference as "processedReference"
       from payment_refunds where order_id = $1 order by requested_at desc, id desc`,
    [orderId],
  )
  return result.rows
}

export async function getCustomerPaymentAudit(
  orderId: string,
  branchId: string,
  client?: PoolClient,
) {
  const result = await (client ?? pool).query(
    `select a.id::text as id, a.action, u.name as "actorName",
            a.old_value as "oldValue", a.new_value as "newValue", a.created_at as "createdAt"
       from audit_logs a left join users u on u.id = a.user_id
      where a.branch_id = $2 and (
        (a.entity_type = 'order' and a.entity_id = $1)
        or (a.entity_type = 'payment' and exists (
          select 1 from payments p where p.id = a.entity_id and p.order_id = $1))
        or (a.entity_type = 'payment_refund' and exists (
          select 1 from payment_refunds r where r.id = a.entity_id and r.order_id = $1))
      ) order by a.created_at desc, a.id desc limit 25`,
    [orderId, branchId],
  )
  return result.rows
}

export async function getCustomerBalanceSummary(branchId?: string | null) {
  const result = await pool.query<{ outstandingBalance: string; outstandingOrders: number }>(
    `select round(coalesce(sum(financial.balance), 0), 2)::text as "outstandingBalance",
            count(*)::int as "outstandingOrders"
       from (${orderPaymentAmountsSql}) financial
      where financial.status <> 'Cancelled' and financial.balance > 0
        and ($1::uuid is null or financial.branch_id = $1)`,
    [branchId ?? null],
  )
  return result.rows[0] ?? { outstandingBalance: '0.00', outstandingOrders: 0 }
}
