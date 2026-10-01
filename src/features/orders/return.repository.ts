import type { PoolClient } from 'pg'

export async function findReturnByRequestKey(client: PoolClient, requestKey: string) {
  const result = await client.query<{
    id: string
    reference: string
    orderId: string
    deliveryId: string
    status: string
    reason: string
    notes: string | null
  }>(
    `select id::text as id, reference, order_id::text as "orderId", delivery_id::text as "deliveryId",
            status, reason, notes
       from order_returns where request_key = $1`,
    [requestKey],
  )
  return result.rows[0]
}

export async function findDeliveryForReturn(
  client: PoolClient,
  orderId: string,
  deliveryId: string,
) {
  const result = await client.query<{ id: string; status: string }>(
    'select id::text as id, status from deliveries where id = $1 and order_id = $2 for update',
    [deliveryId, orderId],
  )
  return result.rows[0]
}

export async function getDeliveryItemQuantities(client: PoolClient, deliveryId: string) {
  const result = await client.query<{ orderItemId: string; quantity: string }>(
    `select order_item_id::text as "orderItemId", sum(quantity)::text as quantity
       from delivery_items where delivery_id = $1 group by order_item_id`,
    [deliveryId],
  )
  return result.rows
}

export async function getReturnedQuantities(client: PoolClient, orderId: string) {
  const result = await client.query<{ orderItemId: string; received: string; pending: string }>(
    `select ri.order_item_id::text as "orderItemId",
            coalesce(sum(ri.quantity) filter (where r.status = 'Received'), 0)::text as received,
            coalesce(sum(ri.quantity) filter (where r.status in ('Requested', 'Approved')), 0)::text as pending
       from order_return_items ri join order_returns r on r.id = ri.return_id
      where r.order_id = $1 group by ri.order_item_id`,
    [orderId],
  )
  return result.rows
}

export async function getDeliveryReturnQuantities(client: PoolClient, deliveryId: string) {
  const result = await client.query<{ orderItemId: string; returned: string; pending: string }>(
    `select ri.order_item_id::text as "orderItemId",
            coalesce(sum(ri.quantity) filter (where r.status = 'Received'), 0)::text as returned,
            coalesce(sum(ri.quantity) filter (where r.status in ('Requested', 'Approved')), 0)::text as pending
       from order_return_items ri join order_returns r on r.id = ri.return_id
      where r.delivery_id = $1 group by ri.order_item_id`,
    [deliveryId],
  )
  return result.rows
}

export async function insertReturn(
  client: PoolClient,
  values: {
    reference: string
    requestKey: string
    orderId: string
    deliveryId: string
    reason: string
    notes: string | null
    requestedBy: string
  },
) {
  const result = await client.query<{ id: string }>(
    `insert into order_returns (reference, request_key, order_id, delivery_id, reason, notes, requested_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id::text as id`,
    [
      values.reference,
      values.requestKey,
      values.orderId,
      values.deliveryId,
      values.reason,
      values.notes,
      values.requestedBy,
    ],
  )
  return result.rows[0]?.id
}

export async function insertReturnItem(
  client: PoolClient,
  values: { returnId: string; orderItemId: string; quantity: string },
) {
  await client.query(
    `insert into order_return_items (return_id, order_item_id, quantity, condition)
     values ($1, $2, $3, 'Resalable')`,
    [values.returnId, values.orderItemId, values.quantity],
  )
}

export async function findReturnOrderId(client: PoolClient, returnId: string) {
  const result = await client.query<{ orderId: string }>(
    'select order_id::text as "orderId" from order_returns where id = $1',
    [returnId],
  )
  return result.rows[0]?.orderId
}

export async function findReturnForUpdate(client: PoolClient, returnId: string) {
  const result = await client.query<{
    id: string
    orderId: string
    deliveryId: string
    reference: string
    status: string
  }>(
    `select id::text as id, order_id::text as "orderId", delivery_id::text as "deliveryId",
            reference, status from order_returns where id = $1 for update`,
    [returnId],
  )
  return result.rows[0]
}

export async function getReturnItemsForUpdate(client: PoolClient, returnId: string) {
  const result = await client.query<{
    orderItemId: string
    productId: string
    productName: string
    unit: string
    quantity: string
  }>(
    `select ri.order_item_id::text as "orderItemId", oi.product_id::text as "productId",
            p.name as "productName", p.unit, ri.quantity::text as quantity
       from order_return_items ri join order_items oi on oi.id = ri.order_item_id
       join products p on p.id = oi.product_id
      where ri.return_id = $1 order by ri.order_item_id for update of ri`,
    [returnId],
  )
  return result.rows
}

export async function transitionReturn(
  client: PoolClient,
  values: {
    returnId: string
    from: string
    to: 'Approved' | 'Rejected' | 'Received'
    userId: string
    reason?: string
  },
) {
  const result = await client.query(
    `update order_returns
        set status = $3,
            approved_by = case when $3 = 'Approved' then $4::uuid else approved_by end,
            approved_at = case when $3 = 'Approved' then now() else approved_at end,
            rejected_by = case when $3 = 'Rejected' then $4::uuid else rejected_by end,
            rejected_at = case when $3 = 'Rejected' then now() else rejected_at end,
            rejection_notes = case when $3 = 'Rejected' then $5::text else rejection_notes end,
            received_by = case when $3 = 'Received' then $4::uuid else received_by end,
            received_at = case when $3 = 'Received' then now() else received_at end
      where id = $1 and status = $2`,
    [values.returnId, values.from, values.to, values.userId, values.reason ?? null],
  )
  return result.rowCount === 1
}

export async function classifyReturnItem(
  client: PoolClient,
  values: {
    returnId: string
    orderItemId: string
    condition: string
    acceptedQuantity: string
    remainderCondition: string | null
  },
) {
  const result = await client.query(
    `update order_return_items
        set condition = $3, accepted_quantity = $4, remainder_condition = $5
      where return_id = $1 and order_item_id = $2 and $4::numeric <= quantity
        and ($3 = 'Resalable' or $4::numeric = 0)`,
    [
      values.returnId,
      values.orderItemId,
      values.condition,
      values.acceptedQuantity,
      values.remainderCondition,
    ],
  )
  return result.rowCount === 1
}

export async function listOrderReturns(client: PoolClient, orderId: string) {
  const result = await client.query(
    `select r.id::text as id, r.reference, r.delivery_id::text as "deliveryId",
            d.reference as "deliveryReference", r.reason, r.notes, r.status,
            r.requested_at as "requestedAt", r.approved_at as "approvedAt",
            r.received_at as "receivedAt", r.rejection_notes as "rejectionNotes",
            requester.name as "requestedByName", approver.name as "approvedByName", receiver.name as "receivedByName",
            coalesce((select json_agg(json_build_object(
              'orderItemId', ri.order_item_id::text,
              'productName', p.name,
              'sku', p.sku,
              'quantity', ri.quantity::text,
              'condition', ri.condition,
              'acceptedQuantity', ri.accepted_quantity::text,
              'remainderCondition', ri.remainder_condition
            ) order by p.name) from order_return_items ri
              join order_items oi on oi.id = ri.order_item_id join products p on p.id = oi.product_id
             where ri.return_id = r.id), '[]'::json) as items
       from order_returns r join deliveries d on d.id = r.delivery_id
       join users requester on requester.id = r.requested_by
       left join users approver on approver.id = r.approved_by
       left join users receiver on receiver.id = r.received_by
      where r.order_id = $1 order by r.requested_at desc, r.id desc`,
    [orderId],
  )
  return result.rows
}

export async function insertReturnAudit(
  client: PoolClient,
  values: {
    userId: string
    branchId: string
    returnId: string
    action: string
    payload: Record<string, unknown>
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    `insert into audit_logs
       (user_id, branch_id, action, entity_type, entity_id, new_value, ip_address, request_id)
     values ($1, $2, $3, 'order_return', $4, $5, $6, $7)`,
    [
      values.userId,
      values.branchId,
      values.action,
      values.returnId,
      values.payload,
      values.ipAddress,
      values.requestId,
    ],
  )
}

export async function insertReturnInventoryMovement(
  client: PoolClient,
  values: {
    productId: string
    branchId: string
    quantity: string
    returnId: string
    note: string
    userId: string
  },
) {
  await client.query(
    `insert into inventory_transactions
       (product_id, branch_id, transaction_type, quantity_delta, reference_type, reference_id, note, performed_by)
     values ($1, $2, 'RETURN_IN', $3, 'OrderReturn', $4, $5, $6)`,
    [
      values.productId,
      values.branchId,
      values.quantity,
      values.returnId,
      values.note,
      values.userId,
    ],
  )
}
