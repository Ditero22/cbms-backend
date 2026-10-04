import type { PoolClient } from 'pg'

import type { OrderLifecycleItem, OrderLifecycleSnapshot } from './order-lifecycle.domain.js'

export async function lockOrder(client: PoolClient, orderId: string) {
  const result = await client.query(
    `select o.id, o.order_number as "orderNumber", o.branch_id as "branchId",
            o.status, o.stock_mode as "stockMode", o.total_amount::text as "totalAmount",
            c.name as "customerName"
       from orders o
       join customers c on c.id = o.customer_id
      where o.id = $1
      for update of o`,
    [orderId],
  )
  return result.rows[0] as
    | Omit<
        OrderLifecycleSnapshot,
        | 'items'
        | 'paidAmount'
        | 'processedRefundAmount'
        | 'pendingRefundAmount'
        | 'pendingReturnCount'
        | 'hasPayments'
        | 'hasActiveDelivery'
        | 'hasUnverifiedLegacyDelivery'
      >
    | undefined
}

export async function lockOrderItems(client: PoolClient, orderId: string) {
  await client.query('select id from order_items where order_id = $1 order by id for update', [
    orderId,
  ])
}

export async function getOrderLifecycleSnapshot(client: PoolClient, orderId: string) {
  const orderResult = await client.query<{
    id: string
    orderNumber: string
    branchId: string
    customerName: string
    status: string
    stockMode: 'Reserved' | 'LegacyConsumed'
    totalAmount: string
  }>(
    `select o.id::text as id, o.order_number as "orderNumber", o.branch_id::text as "branchId",
              c.name as "customerName", o.status, o.stock_mode as "stockMode",
              o.total_amount::text as "totalAmount"
         from orders o join customers c on c.id = o.customer_id where o.id = $1`,
    [orderId],
  )
  const itemResult = await client.query<OrderLifecycleItem>(
    `select oi.id::text as id, oi.product_id::text as "productId", p.name as "productName",
              p.sku, p.unit, oi.quantity::text as quantity,
              oi.cancelled_quantity::text as "cancelledQuantity", oi.unit_price::text as "unitPrice",
              oi.line_total::text as "lineTotal",
              coalesce(delivered.quantity, 0)::text as "deliveredQuantity",
              coalesce(returned.quantity, 0)::text as "returnedQuantity",
              coalesce(pending_delivery.quantity, 0)::text as "pendingDeliveryQuantity",
              coalesce(pending_return.quantity, 0)::text as "pendingReturnQuantity",
              coalesce(reservation.available, 0)::text as "availableReservationQuantity",
              coalesce(reservation.remaining, 0)::text as "reservationQuantity"
         from order_items oi
         join products p on p.id = oi.product_id
         left join lateral (
           select sum(di.quantity) as quantity
             from delivery_items di join deliveries d on d.id = di.delivery_id
            where di.order_item_id = oi.id and d.status = 'Delivered'
         ) delivered on true
         left join lateral (
           select sum(ri.quantity) as quantity
             from order_return_items ri join order_returns r on r.id = ri.return_id
            where ri.order_item_id = oi.id and r.status = 'Received'
         ) returned on true
         left join lateral (
           select sum(di.quantity) as quantity
             from delivery_items di join deliveries d on d.id = di.delivery_id
            where di.order_item_id = oi.id and d.status in ('Preparing', 'Scheduled', 'In Transit')
         ) pending_delivery on true
         left join lateral (
           select sum(ri.quantity) as quantity
             from order_return_items ri join order_returns r on r.id = ri.return_id
            where ri.order_item_id = oi.id and r.status in ('Requested', 'Approved')
         ) pending_return on true
         left join lateral (
           select sum(r.quantity - r.fulfilled_quantity - r.released_quantity -
                      coalesce(active.quantity, 0)) as available,
                  sum(r.quantity - r.fulfilled_quantity - r.released_quantity) as remaining
             from order_reservations r
             left join lateral (
               select sum(di.quantity) as quantity
                 from delivery_items di join deliveries d on d.id = di.delivery_id
                where di.reservation_id = r.id
                  and d.status in ('Preparing', 'Scheduled', 'In Transit')
             ) active on true
            where r.order_item_id = oi.id
         ) reservation on true
        where oi.order_id = $1
        order by oi.id`,
    [orderId],
  )
  const financeResult = await client.query<{
    paidAmount: string
    processedRefundAmount: string
    pendingRefundAmount: string
    hasPayments: boolean
  }>(
    `select coalesce((select sum(p.amount) from payments p where p.order_id = $1 and p.status = 'Paid'), 0)::text as "paidAmount",
              coalesce((select sum(r.amount) from payment_refunds r where r.order_id = $1 and r.status = 'Processed'), 0)::text as "processedRefundAmount",
              coalesce((select sum(r.amount) from payment_refunds r where r.order_id = $1 and r.status in ('Requested', 'Approved')), 0)::text as "pendingRefundAmount",
              exists(select 1 from payments p where p.order_id = $1) as "hasPayments"`,
    [orderId],
  )
  const workflowResult = await client.query<{
    pendingReturnCount: string
    hasActiveDelivery: boolean
    hasUnverifiedLegacyDelivery: boolean
  }>(
    `select (select count(*) from order_returns r where r.order_id = $1 and r.status in ('Requested', 'Approved'))::text as "pendingReturnCount",
              exists(select 1 from deliveries d where d.order_id = $1 and d.status in ('Preparing', 'Scheduled', 'In Transit')) as "hasActiveDelivery",
              exists(select 1 from deliveries d where d.order_id = $1 and d.allocation_status = 'Unverified') as "hasUnverifiedLegacyDelivery"`,
    [orderId],
  )

  const order = orderResult.rows[0]
  if (!order) return undefined
  return {
    ...order,
    items: itemResult.rows,
    paidAmount: financeResult.rows[0]?.paidAmount ?? '0.00',
    processedRefundAmount: financeResult.rows[0]?.processedRefundAmount ?? '0.00',
    pendingRefundAmount: financeResult.rows[0]?.pendingRefundAmount ?? '0.00',
    hasPayments: financeResult.rows[0]?.hasPayments ?? false,
    pendingReturnCount: Number(workflowResult.rows[0]?.pendingReturnCount ?? 0),
    hasActiveDelivery: workflowResult.rows[0]?.hasActiveDelivery ?? false,
    hasUnverifiedLegacyDelivery: workflowResult.rows[0]?.hasUnverifiedLegacyDelivery ?? false,
  } satisfies OrderLifecycleSnapshot
}

export async function getReservationRowsForUpdate(client: PoolClient, orderItemId: string) {
  const result = await client.query<{
    id: string
    quantity: string
    fulfilledQuantity: string
    releasedQuantity: string
    pendingQuantity: string
  }>(
    `select r.id::text as id, r.quantity::text as quantity,
            r.fulfilled_quantity::text as "fulfilledQuantity",
            r.released_quantity::text as "releasedQuantity",
            coalesce(active.quantity, 0)::text as "pendingQuantity"
       from order_reservations r
       left join lateral (
         select sum(di.quantity) as quantity
           from delivery_items di join deliveries d on d.id = di.delivery_id
          where di.reservation_id = r.id
            and d.status in ('Preparing', 'Scheduled', 'In Transit')
       ) active on true
      where r.order_item_id = $1
      order by r.created_at, r.id
      for update of r`,
    [orderItemId],
  )
  return result.rows
}

export async function insertOrderReservation(
  client: PoolClient,
  values: { orderItemId: string; quantity: string; createdBy: string },
) {
  const result = await client.query<{ id: string }>(
    `insert into order_reservations (order_item_id, quantity, created_by)
     values ($1, $2, $3) returning id::text as id`,
    [values.orderItemId, values.quantity, values.createdBy],
  )
  return result.rows[0]?.id
}

export async function allocateReservationToDeliveryItem(
  client: PoolClient,
  values: {
    deliveryId: string
    orderItemId: string
    reservationId: string | null
    quantity: string
  },
) {
  await client.query(
    `insert into delivery_items (delivery_id, order_item_id, reservation_id, quantity)
     values ($1, $2, $3, $4)`,
    [values.deliveryId, values.orderItemId, values.reservationId, values.quantity],
  )
}

export async function lockInventory(client: PoolClient, productId: string, branchId: string) {
  const result = await client.query<{ quantity: string; reservedQuantity: string }>(
    `select quantity::text as quantity, reserved_quantity::text as "reservedQuantity"
       from inventory where product_id = $1 and branch_id = $2 for update`,
    [productId, branchId],
  )
  return result.rows[0]
}

export async function markReservationFulfilled(
  client: PoolClient,
  reservationId: string,
  quantity: string,
) {
  const result = await client.query(
    `update order_reservations
        set fulfilled_quantity = fulfilled_quantity + $2
      where id = $1 and fulfilled_quantity + released_quantity + $2 <= quantity`,
    [reservationId, quantity],
  )
  return result.rowCount === 1
}

export async function markReservationReleased(
  client: PoolClient,
  reservationId: string,
  quantity: string,
) {
  const result = await client.query(
    `update order_reservations
        set released_quantity = released_quantity + $2
      where id = $1 and fulfilled_quantity + released_quantity + $2 <= quantity`,
    [reservationId, quantity],
  )
  return result.rowCount === 1
}

export async function getDeliveryItems(client: PoolClient, deliveryId: string) {
  const result = await client.query<{
    orderItemId: string
    reservationId: string | null
    productId: string
    quantity: string
  }>(
    `select di.order_item_id::text as "orderItemId", di.reservation_id::text as "reservationId",
            oi.product_id::text as "productId", di.quantity::text as quantity
       from delivery_items di join order_items oi on oi.id = di.order_item_id
      where di.delivery_id = $1 order by oi.product_id, oi.id, di.reservation_id`,
    [deliveryId],
  )
  return result.rows
}

export async function setItemCancelledQuantity(
  client: PoolClient,
  orderItemId: string,
  quantity: string,
) {
  await client.query(
    'update order_items set cancelled_quantity = cancelled_quantity + $2 where id = $1',
    [orderItemId, quantity],
  )
}

export async function adjustInventoryReservation(
  client: PoolClient,
  values: { productId: string; branchId: string; quantityDelta: string },
) {
  const result = await client.query<{ quantity: string; reservedQuantity: string }>(
    `update inventory
        set reserved_quantity = reserved_quantity + $3, updated_at = now()
      where product_id = $1 and branch_id = $2
        and reserved_quantity + $3 >= 0
        and reserved_quantity + $3 <= quantity
      returning quantity::text as quantity, reserved_quantity::text as "reservedQuantity"`,
    [values.productId, values.branchId, values.quantityDelta],
  )
  return result.rows[0]
}

export async function deliverReservedInventory(
  client: PoolClient,
  values: { productId: string; branchId: string; quantity: string },
) {
  const result = await client.query<{ quantity: string; reservedQuantity: string }>(
    `update inventory
        set quantity = quantity - $3, reserved_quantity = reserved_quantity - $3, updated_at = now()
      where product_id = $1 and branch_id = $2 and quantity >= $3 and reserved_quantity >= $3
      returning quantity::text as quantity, reserved_quantity::text as "reservedQuantity"`,
    [values.productId, values.branchId, values.quantity],
  )
  return result.rows[0]
}

export async function restockInventory(
  client: PoolClient,
  values: { productId: string; branchId: string; quantity: string },
) {
  const result = await client.query<{ quantity: string }>(
    `insert into inventory (product_id, branch_id, quantity)
     values ($1, $2, $3)
     on conflict (product_id, branch_id) do update
       set quantity = inventory.quantity + excluded.quantity, updated_at = now()
     returning quantity::text as quantity`,
    [values.productId, values.branchId, values.quantity],
  )
  return result.rows[0]
}

export async function insertLifecycleInventoryMovement(
  client: PoolClient,
  values: {
    productId: string
    branchId: string
    transactionType: string
    quantityDelta: string
    orderId: string
    note: string
    performedBy: string
  },
) {
  const result = await client.query<{ id: string }>(
    `insert into inventory_transactions
       (product_id, branch_id, transaction_type, quantity_delta, reference_type, reference_id, note, performed_by)
     values ($1, $2, $3, $4, 'Order', $5, $6, $7) returning id::text as id`,
    [
      values.productId,
      values.branchId,
      values.transactionType,
      values.quantityDelta,
      values.orderId,
      values.note,
      values.performedBy,
    ],
  )
  return result.rows[0]?.id
}

export async function updateOrderStatus(
  client: PoolClient,
  values: {
    orderId: string
    status: string
    completedBy?: string
    cancelledBy?: string
    reason?: string
    notes?: string | null
  },
) {
  await client.query(
    `update orders
        set status = $2,
            completed_at = case when $2 = 'Completed' then now() else completed_at end,
            completed_by = case when $2 = 'Completed' then $3::uuid else completed_by end,
            cancelled_at = case when $2 = 'Cancelled' then now() else cancelled_at end,
            cancelled_by = case when $2 = 'Cancelled' then $4::uuid else cancelled_by end,
            cancellation_reason = coalesce($5, cancellation_reason),
            cancellation_notes = coalesce($6, cancellation_notes),
            updated_at = now()
      where id = $1`,
    [
      values.orderId,
      values.status,
      values.completedBy ?? null,
      values.cancelledBy ?? null,
      values.reason ?? null,
      values.notes ?? null,
    ],
  )
}

export async function insertOrderLifecycleAudit(
  client: PoolClient,
  values: {
    userId: string
    branchId: string
    orderId: string
    action: string
    data: Record<string, unknown>
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    `insert into audit_logs
       (user_id, branch_id, action, entity_type, entity_id, new_value, ip_address, request_id)
     values ($1, $2, $3, 'order', $4, $5, $6, $7)`,
    [
      values.userId,
      values.branchId,
      values.action,
      values.orderId,
      values.data,
      values.ipAddress,
      values.requestId,
    ],
  )
}
