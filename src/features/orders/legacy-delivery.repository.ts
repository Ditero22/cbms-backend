import type { PoolClient } from 'pg'

export type LegacyOrderLine = {
  orderItemId: string
  productName: string
  sku: string
  unit: string
  orderedQuantity: string
  cancelledQuantity: string
}

export type DeliveryAllocationRow = {
  id: string
  deliveryId: string
  orderItemId: string
  quantity: string
  inferredQuantity: string | null
  reservationId: string | null
}

export type LegacyDeliveryRow = {
  id: string
  reference: string
  status: string
  allocationOrigin: 'Recorded' | 'LegacyBackfill'
  allocationStatus: 'Verified' | 'Unverified'
  allocationVerifiedAt: Date | null
  allocationVerifiedBy: string | null
}

export async function findUnverifiedLegacyDelivery(client: PoolClient, orderId: string) {
  const result = await client.query<{ reference: string }>(
    `select d.reference from deliveries d join orders o on o.id = d.order_id
      where o.id = $1 and o.stock_mode = 'LegacyConsumed'
        and d.allocation_status = 'Unverified'
      order by d.created_at, d.id limit 1`,
    [orderId],
  )
  return result.rows[0]
}

export async function findOrder(client: PoolClient, orderId: string, lock: boolean) {
  const result = await client.query<{
    id: string
    branchId: string
    stockMode: 'LegacyConsumed' | 'Reserved'
    status: string
  }>(
    `select id::text as id, branch_id::text as "branchId", stock_mode as "stockMode", status
       from orders where id = $1 ${lock ? 'for update' : ''}`,
    [orderId],
  )
  return result.rows[0]
}

export async function lockOrderLines(client: PoolClient, orderId: string) {
  await client.query('select id from order_items where order_id = $1 order by id for update', [
    orderId,
  ])
}

export async function getOrderLines(client: PoolClient, orderId: string) {
  const result = await client.query<LegacyOrderLine>(
    `select oi.id::text as "orderItemId", p.name as "productName", p.sku, p.unit,
            oi.quantity::text as "orderedQuantity",
            oi.cancelled_quantity::text as "cancelledQuantity"
       from order_items oi join products p on p.id = oi.product_id
      where oi.order_id = $1 order by oi.id`,
    [orderId],
  )
  return result.rows
}

export async function getDeliveries(client: PoolClient, orderId: string) {
  const result = await client.query<LegacyDeliveryRow>(
    `select id::text as id, reference, status,
            allocation_origin as "allocationOrigin", allocation_status as "allocationStatus",
            allocation_verified_at as "allocationVerifiedAt",
            allocation_verified_by::text as "allocationVerifiedBy"
       from deliveries where order_id = $1 order by created_at, id`,
    [orderId],
  )
  return result.rows
}

export async function lockDelivery(client: PoolClient, orderId: string, deliveryId: string) {
  const result = await client.query<LegacyDeliveryRow>(
    `select id::text as id, reference, status,
            allocation_origin as "allocationOrigin", allocation_status as "allocationStatus",
            allocation_verified_at as "allocationVerifiedAt",
            allocation_verified_by::text as "allocationVerifiedBy"
       from deliveries where order_id = $1 and id = $2 for update`,
    [orderId, deliveryId],
  )
  return result.rows[0]
}

export async function getDeliveryAllocations(client: PoolClient, orderId: string) {
  const result = await client.query<DeliveryAllocationRow>(
    `select di.id::text as id, di.delivery_id::text as "deliveryId",
            di.order_item_id::text as "orderItemId", di.quantity::text as quantity,
            di.inferred_quantity::text as "inferredQuantity",
            di.reservation_id::text as "reservationId"
       from delivery_items di join deliveries d on d.id = di.delivery_id
      where d.order_id = $1 order by d.created_at, di.order_item_id, di.id`,
    [orderId],
  )
  return result.rows
}

export async function lockDeliveryAllocations(client: PoolClient, deliveryId: string) {
  const result = await client.query<DeliveryAllocationRow>(
    `select id::text as id, delivery_id::text as "deliveryId",
            order_item_id::text as "orderItemId", quantity::text as quantity,
            inferred_quantity::text as "inferredQuantity",
            reservation_id::text as "reservationId"
       from delivery_items where delivery_id = $1 order by order_item_id, id for update`,
    [deliveryId],
  )
  return result.rows
}

export async function getOtherAllocations(client: PoolClient, orderId: string, deliveryId: string) {
  const result = await client.query<{
    orderItemId: string
    quantity: string
    verifiedQuantity: string
  }>(
    `select di.order_item_id::text as "orderItemId", sum(di.quantity)::text as quantity,
            coalesce(sum(di.quantity) filter (where d.allocation_status = 'Verified'), 0)::text as "verifiedQuantity"
       from delivery_items di
       join deliveries d on d.id = di.delivery_id
      where d.order_id = $1 and d.id <> $2
        and d.status in ('Preparing', 'Scheduled', 'In Transit', 'Delivered')
      group by di.order_item_id`,
    [orderId, deliveryId],
  )
  return result.rows
}

export async function hasOrderReturnHistory(client: PoolClient, orderId: string) {
  const result = await client.query<{ exists: boolean }>(
    'select exists(select 1 from order_returns where order_id = $1) as exists',
    [orderId],
  )
  return result.rows[0]?.exists ?? false
}

export async function hasDeliveryStockMovement(client: PoolClient, orderId: string) {
  const result = await client.query<{ exists: boolean }>(
    `select exists(select 1 from inventory_transactions
      where reference_type = 'Order' and reference_id = $1
        and transaction_type = 'DELIVERY_OUT') as exists`,
    [orderId],
  )
  return result.rows[0]?.exists ?? false
}

export async function replaceDeliveryAllocations(
  client: PoolClient,
  deliveryId: string,
  items: { orderItemId: string; quantity: string; inferredQuantity: string | null }[],
) {
  await client.query('delete from delivery_items where delivery_id = $1', [deliveryId])
  for (const item of items) {
    if (item.quantity === '0.000') continue
    await client.query(
      `insert into delivery_items (delivery_id, order_item_id, quantity, inferred_quantity)
       values ($1, $2, $3, $4)`,
      [deliveryId, item.orderItemId, item.quantity, item.inferredQuantity],
    )
  }
}

export async function markDeliveryVerified(client: PoolClient, deliveryId: string, userId: string) {
  await client.query(
    `update deliveries
        set allocation_status = 'Verified', allocation_verified_at = now(),
            allocation_verified_by = $2, updated_at = now()
      where id = $1 and allocation_status = 'Unverified'`,
    [deliveryId, userId],
  )
}

export async function setOrderStatus(client: PoolClient, orderId: string, status: string) {
  await client.query('update orders set status = $2, updated_at = now() where id = $1', [
    orderId,
    status,
  ])
}

export async function insertReconciliationAudit(
  client: PoolClient,
  values: {
    userId: string
    branchId: string
    deliveryId: string
    oldValue: Record<string, unknown>
    newValue: Record<string, unknown>
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    `insert into audit_logs
       (user_id, branch_id, action, entity_type, entity_id, old_value, new_value, ip_address, request_id)
     values ($1, $2, 'reconciled legacy delivery allocation', 'delivery', $3, $4, $5, $6, $7)`,
    [
      values.userId,
      values.branchId,
      values.deliveryId,
      values.oldValue,
      values.newValue,
      values.ipAddress,
      values.requestId,
    ],
  )
}
