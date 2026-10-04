import type { PoolClient } from 'pg'
import { pool } from '@/database/client.js'

export async function getOrderOptions(branchId?: string | null) {
  const [customers, products, branches] = await Promise.all([
    pool.query<{ id: string; name: string }>(
      "select id, name from customers where deleted_at is null and status = 'Active' and ($1::uuid is null or branch_id = $1) order by name",
      [branchId ?? null],
    ),
    pool.query<{ id: string; name: string; sku: string; unit: string; unitPrice: string }>(
      'select id, name, sku, unit, unit_price as "unitPrice" from products where deleted_at is null and status = \'Active\' order by name',
    ),
    pool.query<{ id: string; name: string }>(
      `select id, name from branches where deleted_at is null and status = 'Active'${
        branchId ? ' and id = $1' : ''
      } order by name`,
      branchId ? [branchId] : [],
    ),
  ])

  return {
    customers: customers.rows,
    products: products.rows,
    branches: branches.rows,
  }
}

export async function getOrderDetail(
  client: PoolClient,
  orderId: string,
  branchId: string | undefined,
) {
  const orderResult = await client.query<{
    id: string
    orderNumber: string
    customerName: string
    branchId: string
    branchName: string
    totalAmount: string
    status: string
    createdBy: string
    createdByName: string
    createdAt: Date
    updatedAt: Date
    cancelledAt: Date | null
    cancelledBy: string | null
    cancellationReason: string | null
    cancellationNotes: string | null
    completedAt: Date | null
  }>(
    `select o.id::text as id, o.order_number as "orderNumber", c.name as "customerName",
            o.branch_id::text as "branchId", b.name as "branchName", o.total_amount::text as "totalAmount",
            o.status, o.created_by::text as "createdBy", u.name as "createdByName",
            o.created_at as "createdAt", o.updated_at as "updatedAt", o.cancelled_at as "cancelledAt",
            o.cancelled_by::text as "cancelledBy", o.cancellation_reason as "cancellationReason",
            o.cancellation_notes as "cancellationNotes", o.completed_at as "completedAt"
     from orders o
     join customers c on c.id = o.customer_id
     join branches b on b.id = o.branch_id
     join users u on u.id = o.created_by
     where o.id = $1 and ($2::uuid is null or o.branch_id = $2)`,
    [orderId, branchId ?? null],
  )
  const order = orderResult.rows[0]
  if (!order) return undefined

  const items = await client.query(
    `select oi.id::text as id, oi.product_id::text as "productId", p.name as "productName",
              p.sku, p.unit, oi.quantity::text as quantity, oi.unit_price::text as "unitPrice",
              oi.line_total::text as "lineTotal", oi.cancelled_quantity::text as "cancelledQuantity",
              coalesce(delivered.quantity, 0)::text as "deliveredQuantity",
              coalesce(returned.quantity, 0)::text as "returnedQuantity"
       from order_items oi join products p on p.id = oi.product_id
       left join lateral (
         select sum(di.quantity) as quantity from delivery_items di join deliveries d on d.id = di.delivery_id
          where di.order_item_id = oi.id and d.status = 'Delivered'
       ) delivered on true
       left join lateral (
         select sum(ri.quantity) as quantity from order_return_items ri join order_returns r on r.id = ri.return_id
          where ri.order_item_id = oi.id and r.status = 'Received'
       ) returned on true
       where oi.order_id = $1 order by oi.id`,
    [orderId],
  )
  const payments = await client.query(
    `select p.id::text as id, p.reference, p.method, p.amount::text as amount, p.status,
              p.created_at as "createdAt", u.name as "recordedByName",
              p.payment_date::text as "paymentDate", p.external_reference as "externalReference", p.notes
       from payments p join users u on u.id = p.recorded_by
       where p.order_id = $1 order by p.created_at desc, p.id desc`,
    [orderId],
  )
  const deliveries = await client.query(
    `select d.id::text as id, d.reference, d.destination, d.driver_name as "driverName",
              fleet.id as "assignmentId",v.name as "vehicleName",v.plate_number as "plateNumber",
              d.scheduled_at as "scheduledAt", d.status, d.created_at as "createdAt", d.updated_at as "updatedAt",
              coalesce(lines.items, '[]'::json) as items
       from deliveries d
       left join lateral (select id,vehicle_id from vehicle_assignments where delivery_id=d.id order by created_at desc limit 1) fleet on true
       left join vehicles v on v.id=fleet.vehicle_id
       left join lateral (
         select json_agg(json_build_object(
           'orderItemId', lines.order_item_id::text, 'productName', lines.name, 'sku', lines.sku, 'unit', lines.unit,
           'quantity', lines.quantity::text
         ) order by lines.name) as items
           from (
             select di.order_item_id, p.name, p.sku, p.unit, sum(di.quantity) as quantity
               from delivery_items di join order_items oi on oi.id = di.order_item_id
               join products p on p.id = oi.product_id where di.delivery_id = d.id
              group by di.order_item_id, p.name, p.sku, p.unit
           ) lines
       ) lines on true
       where d.order_id = $1 order by d.created_at desc, d.id desc`,
    [orderId],
  )
  const stockMovements = await client.query(
    `select it.id::text as id, it.transaction_type as "transactionType",
              it.quantity_delta::text as "quantityDelta", it.note, it.created_at as "createdAt",
              p.name as "productName", p.sku, u.name as "performedByName"
       from inventory_transactions it
       join products p on p.id = it.product_id
       join users u on u.id = it.performed_by
       where (it.reference_type = 'Order' and it.reference_id = $1)
          or (it.reference_type = 'OrderReturn'
              and it.reference_id in (select r.id from order_returns r where r.order_id = $1))
       order by it.created_at desc, it.id desc`,
    [orderId],
  )
  const refunds = await client.query(
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
  const returns = await client.query(
    `select r.id::text as id, r.reference, r.delivery_id::text as "deliveryId",
              d.reference as "deliveryReference", r.reason, r.notes, r.status,
              r.requested_at as "requestedAt", r.approved_at as "approvedAt", r.received_at as "receivedAt",
              r.rejection_notes as "rejectionNotes", requester.name as "requestedByName",
              approver.name as "approvedByName", receiver.name as "receivedByName",
              coalesce((select json_agg(json_build_object(
                'orderItemId', ri.order_item_id::text, 'productName', p.name, 'sku', p.sku,
                'quantity', ri.quantity::text, 'condition', ri.condition,
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

  return {
    order,
    items: items.rows,
    payments: payments.rows,
    deliveries: deliveries.rows,
    stockMovements: stockMovements.rows,
    refunds: refunds.rows,
    returns: returns.rows,
  }
}

export async function getOrderAuditHistory(
  client: PoolClient,
  orderId: string,
  branchId: string | undefined,
  limit = 25,
) {
  const result = await client.query(
    `select a.id::text as id, a.action, a.old_value as "oldValue", a.new_value as "newValue",
            a.created_at as "createdAt", u.name as "actorName"
     from orders o
     join audit_logs a on a.branch_id = o.branch_id
     left join users u on u.id = a.user_id
     where o.id = $1 and ($2::uuid is null or o.branch_id = $2)
       and (
         (a.entity_type = 'order' and a.entity_id = o.id)
         or (a.entity_type = 'payment' and exists (
           select 1 from payments p where p.id = a.entity_id and p.order_id = o.id
         ))
         -- Creation already writes an order audit entry, so show that event once.
         or (a.entity_type = 'delivery' and a.action <> 'created delivery' and exists (
           select 1 from deliveries d where d.id = a.entity_id and d.order_id = o.id
         ))
         or (a.entity_type = 'payment_refund' and exists (
           select 1 from payment_refunds r where r.id = a.entity_id and r.order_id = o.id
         ))
         or (a.entity_type = 'order_return' and exists (
           select 1 from order_returns r where r.id = a.entity_id and r.order_id = o.id
         ))
       )
     order by a.created_at desc, a.id desc limit $3`,
    [orderId, branchId ?? null, Math.min(Math.max(Math.trunc(limit), 1), 25)],
  )
  return result.rows
}

export async function findActiveBranch(client: PoolClient, branchId: string) {
  const result = await client.query<{ id: string }>(
    "select id from branches where id = $1 and status = 'Active' and deleted_at is null for share",
    [branchId],
  )
  return result.rows[0]
}

export async function findActiveCustomer(
  client: PoolClient,
  customerId: string,
  branchScope?: string | null,
) {
  const branchCondition = branchScope ? ' and branch_id = $2' : ''
  const result = await client.query<{ id: string }>(
    `select id from customers where id = $1 and status = 'Active' and deleted_at is null${branchCondition} for share`,
    branchScope ? [customerId, branchScope] : [customerId],
  )
  return result.rows[0]
}

export async function findActiveProduct(client: PoolClient, productId: string) {
  const result = await client.query<{ id: string; unit_price: string }>(
    "select id, unit_price from products where id = $1 and status = 'Active' and deleted_at is null for share",
    [productId],
  )
  return result.rows[0]
}

export async function findStockForUpdate(client: PoolClient, productId: string, branchId: string) {
  const result = await client.query<{ quantity: string; reservedQuantity: string }>(
    'select quantity::text as quantity, reserved_quantity::text as "reservedQuantity" from inventory where product_id = $1 and branch_id = $2 for update',
    [productId, branchId],
  )
  return result.rows[0]
}

export async function lockOrderCreateRequest(client: PoolClient, requestKey: string) {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `order-create:${requestKey}`,
  ])
}

export async function findOrderCreateRequest(client: PoolClient, requestKey: string) {
  const result = await client.query<{
    id: string
    orderNumber: string
    customerId: string
    branchId: string
    totalAmount: string
    createdBy: string
    productId: string | null
    quantity: string | null
  }>(
    `select o.id::text as id, o.order_number as "orderNumber",
            o.customer_id::text as "customerId", o.branch_id::text as "branchId",
            o.total_amount::text as "totalAmount", o.created_by::text as "createdBy",
            oi.product_id::text as "productId", oi.quantity::text as quantity
       from orders o
       left join order_items oi on oi.order_id = o.id
      where o.request_key = $1
      order by oi.product_id`,
    [requestKey],
  )
  const first = result.rows[0]
  if (!first) return undefined
  return {
    id: first.id,
    orderNumber: first.orderNumber,
    customerId: first.customerId,
    branchId: first.branchId,
    totalAmount: first.totalAmount,
    createdBy: first.createdBy,
    items: result.rows.flatMap((row) =>
      row.productId && row.quantity ? [{ productId: row.productId, quantity: row.quantity }] : [],
    ),
  }
}

export async function insertOrder(
  client: PoolClient,
  values: {
    orderNumber: string
    customerId: string
    branchId: string
    total: string
    createdBy: string
    requestKey: string | null
  },
) {
  const result = await client.query<{ id: string }>(
    `insert into orders (order_number, customer_id, branch_id, total_amount, status, created_by, request_key)
     values ($1, $2, $3, $4, 'Processing', $5, $6) returning id`,
    [
      values.orderNumber,
      values.customerId,
      values.branchId,
      values.total,
      values.createdBy,
      values.requestKey,
    ],
  )
  return result.rows[0]?.id
}

export async function insertOrderItem(
  client: PoolClient,
  values: {
    orderId: string
    productId: string
    quantity: number | string
    unitPrice: string
    lineTotal: string
  },
) {
  const result = await client.query<{ id: string }>(
    'insert into order_items (order_id, product_id, quantity, unit_price, line_total) values ($1, $2, $3, $4, $5) returning id::text as id',
    [values.orderId, values.productId, values.quantity, values.unitPrice, values.lineTotal],
  )
  return result.rows[0]?.id
}

export async function reserveInventory(
  client: PoolClient,
  productId: string,
  branchId: string,
  quantity: number | string,
) {
  const result = await client.query(
    'update inventory set reserved_quantity = reserved_quantity + $3, updated_at = now() where product_id = $1 and branch_id = $2 and quantity - reserved_quantity >= $3',
    [productId, branchId, quantity],
  )
  return result.rowCount === 1
}

export async function insertReservationTransaction(
  client: PoolClient,
  values: {
    productId: string
    branchId: string
    quantity: number | string
    orderId: string
    performedBy: string
  },
) {
  await client.query(
    `insert into inventory_transactions (product_id, branch_id, transaction_type, quantity_delta, reference_type, reference_id, note, performed_by)
     values ($1, $2, 'RESERVATION_CREATED', $3, 'Order', $4, 'Inventory reserved for order', $5)`,
    [values.productId, values.branchId, values.quantity, values.orderId, values.performedBy],
  )
}

export async function insertOrderAuditLog(
  client: PoolClient,
  values: {
    userId: string
    branchId: string
    orderId: string
    orderNumber: string
    customerId: string
    items: { productId: string; quantity: number; unitPrice: string; lineTotal: string }[]
    total: string
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    `insert into audit_logs (user_id, branch_id, action, entity_type, entity_id, new_value, ip_address, request_id)
     values ($1, $2, 'created order', 'order', $3, $4, $5, $6)`,
    [
      values.userId,
      values.branchId,
      values.orderId,
      {
        orderNumber: values.orderNumber,
        customerId: values.customerId,
        items: values.items,
        total: values.total,
      },
      values.ipAddress,
      values.requestId,
    ],
  )
}
