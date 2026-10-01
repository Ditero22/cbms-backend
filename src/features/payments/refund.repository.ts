import type { PoolClient } from 'pg'

export async function findRefundByRequestKey(client: PoolClient, requestKey: string) {
  const result = await client.query<{
    id: string
    reference: string
    orderId: string
    paymentId: string
    amount: string
    status: string
    method: string
    reason: string
    notes: string | null
  }>(
    `select id::text as id, reference, order_id::text as "orderId", payment_id::text as "paymentId",
            amount::text as amount, status, method, reason, notes
       from payment_refunds where request_key = $1`,
    [requestKey],
  )
  return result.rows[0]
}

export async function findPaymentForUpdate(client: PoolClient, orderId: string, paymentId: string) {
  const result = await client.query<{
    id: string
    orderId: string
    amount: string
    status: string
  }>(
    `select id::text as id, order_id::text as "orderId", amount::text as amount, status
       from payments where id = $1 and order_id = $2 for update`,
    [paymentId, orderId],
  )
  return result.rows[0]
}

export async function getRefundTotalsForPayment(client: PoolClient, paymentId: string) {
  const result = await client.query<{ processed: string; pending: string }>(
    `select coalesce(sum(amount) filter (where status = 'Processed'), 0)::text as processed,
            coalesce(sum(amount) filter (where status in ('Requested', 'Approved')), 0)::text as pending
       from payment_refunds where payment_id = $1`,
    [paymentId],
  )
  return result.rows[0] ?? { processed: '0.00', pending: '0.00' }
}

export async function insertRefund(
  client: PoolClient,
  values: {
    reference: string
    requestKey: string
    orderId: string
    paymentId: string
    amount: string
    method: string
    reason: string
    notes: string | null
    requestedBy: string
  },
) {
  const result = await client.query<{ id: string }>(
    `insert into payment_refunds
       (reference, request_key, order_id, payment_id, amount, method, reason, notes, requested_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id::text as id`,
    [
      values.reference,
      values.requestKey,
      values.orderId,
      values.paymentId,
      values.amount,
      values.method,
      values.reason,
      values.notes,
      values.requestedBy,
    ],
  )
  return result.rows[0]?.id
}

export async function findRefundOrderId(client: PoolClient, refundId: string) {
  const result = await client.query<{ orderId: string }>(
    'select order_id::text as "orderId" from payment_refunds where id = $1',
    [refundId],
  )
  return result.rows[0]?.orderId
}

export async function findRefundForUpdate(client: PoolClient, refundId: string) {
  const result = await client.query<{
    id: string
    orderId: string
    paymentId: string
    reference: string
    amount: string
    method: string
    reason: string
    notes: string | null
    status: string
  }>(
    `select id::text as id, order_id::text as "orderId", payment_id::text as "paymentId",
            reference, amount::text as amount, method, reason, notes, status
       from payment_refunds where id = $1 for update`,
    [refundId],
  )
  return result.rows[0]
}

export async function transitionRefund(
  client: PoolClient,
  values: {
    refundId: string
    from: string
    to: 'Approved' | 'Rejected' | 'Processed'
    userId: string
    reason?: string
    reference?: string
  },
) {
  const result = await client.query(
    `update payment_refunds
        set status = $3,
            approved_by = case when $3 = 'Approved' then $4::uuid else approved_by end,
            approved_at = case when $3 = 'Approved' then now() else approved_at end,
            processed_by = case when $3 = 'Processed' then $4::uuid else processed_by end,
            processed_at = case when $3 = 'Processed' then now() else processed_at end,
            processed_reference = case when $3 = 'Processed' then $6 else processed_reference end,
            notes = case when $3 = 'Rejected' then concat_ws(E'\\n', notes, $5::text) else notes end
      where id = $1 and status = $2`,
    [
      values.refundId,
      values.from,
      values.to,
      values.userId,
      values.reason ?? null,
      values.reference ?? null,
    ],
  )
  return result.rowCount === 1
}

export async function listOrderRefundsWithClient(client: PoolClient, orderId: string) {
  const result = await client.query(
    `select r.id::text as id, r.reference, r.payment_id::text as "paymentId",
            p.reference as "paymentReference", r.amount::text as amount, r.method,
            r.reason, r.notes, r.status, r.processed_reference as "processedReference",
            r.requested_at as "requestedAt", r.approved_at as "approvedAt", r.processed_at as "processedAt",
            requester.name as "requestedByName", approver.name as "approvedByName", processor.name as "processedByName"
       from payment_refunds r join payments p on p.id = r.payment_id
       join users requester on requester.id = r.requested_by
       left join users approver on approver.id = r.approved_by
       left join users processor on processor.id = r.processed_by
      where r.order_id = $1 order by r.requested_at desc, r.id desc`,
    [orderId],
  )
  return result.rows
}

export async function insertRefundAudit(
  client: PoolClient,
  values: {
    userId: string
    branchId: string
    refundId: string
    action: string
    payload: Record<string, unknown>
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    `insert into audit_logs
       (user_id, branch_id, action, entity_type, entity_id, new_value, ip_address, request_id)
     values ($1, $2, $3, 'payment_refund', $4, $5, $6, $7)`,
    [
      values.userId,
      values.branchId,
      values.action,
      values.refundId,
      values.payload,
      values.ipAddress,
      values.requestId,
    ],
  )
}
