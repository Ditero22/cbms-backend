import type { PoolClient } from 'pg'
import { pool } from '@/database/client.js'

export async function getDeliveryOptions(branchId?: string) {
  const result = await pool.query<{
    id: string
    orderNumber: string
    customerName: string
    defaultDestination: string | null
    branchId: string
    items: {
      orderItemId: string
      productName: string
      sku: string
      unit: string
      remainingQuantity: string
    }[]
  }>(
    `select o.id,
            o.order_number as "orderNumber",
            c.name as "customerName",
            c.location as "defaultDestination",
            o.branch_id as "branchId",
            lines.items
       from orders o
       join customers c on c.id = o.customer_id
       join lateral (
         select json_agg(json_build_object(
                  'orderItemId', eligible.id::text,
                  'productName', eligible.product_name,
                  'sku', eligible.sku,
                  'unit', eligible.unit,
                  'remainingQuantity', eligible.remaining_quantity
                ) order by eligible.product_name) as items
           from (
             select oi.id, p.name as product_name, p.sku, p.unit,
                    greatest(oi.quantity - oi.cancelled_quantity -
                      coalesce(delivered.quantity, 0) + coalesce(returned.quantity, 0), 0)::text as remaining_quantity
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
              where oi.order_id = o.id
                and oi.quantity - oi.cancelled_quantity - coalesce(delivered.quantity, 0) +
                    coalesce(returned.quantity, 0) > 0
           ) eligible
       ) lines on json_array_length(coalesce(lines.items, '[]'::json)) > 0
      where o.status not in ('Cancelled', 'Completed')
        and ($1::uuid is null or o.branch_id = $1)
        and not exists (
          select 1 from deliveries d where d.order_id = o.id and d.allocation_status = 'Unverified'
        )
        and not exists (
          select 1 from order_returns r where r.order_id = o.id and r.status in ('Requested', 'Approved')
        )
        and not exists (
          select 1 from deliveries d where d.order_id = o.id and d.status in ('Preparing', 'Scheduled', 'In Transit')
        )
      order by o.created_at desc`,
    [branchId ?? null],
  )
  return result.rows
}

export async function findDeliveryDetail(
  client: PoolClient,
  deliveryId: string,
  branchScope?: string,
) {
  const result = await client.query<{
    id: string
    reference: string
    status: string
    destination: string
    driverName: string | null
    scheduledAt: Date | null
    allocationOrigin: string
    allocationStatus: string
    allocationVerifiedAt: Date | null
    allocationVerifiedByName: string | null
    orderId: string
    orderNumber: string
    orderStatus: string
    customerName: string
    branchId: string
    branchName: string
    vehicleName: string | null
    plateNumber: string | null
    assignmentReference: string | null
    assignmentStatus: string | null
    assignmentStartedAt: Date | null
    assignmentEndedAt: Date | null
    startOdometer: string | null
    endOdometer: string | null
    activityNotes: string | null
    createdAt: Date
    updatedAt: Date
  }>(
    `select d.id::text as id,d.reference,d.status,d.destination,
            coalesce(assigned_driver.name,d.driver_name) as "driverName",
            d.scheduled_at as "scheduledAt",d.allocation_origin as "allocationOrigin",
            d.allocation_status as "allocationStatus",d.allocation_verified_at as "allocationVerifiedAt",
            verifier.name as "allocationVerifiedByName",
            o.id::text as "orderId",o.order_number as "orderNumber",o.status as "orderStatus",
            c.name as "customerName",o.branch_id::text as "branchId",b.name as "branchName",
            v.name as "vehicleName",v.plate_number as "plateNumber",
            assignment.reference as "assignmentReference",assignment.status as "assignmentStatus",
            assignment.started_at as "assignmentStartedAt",assignment.ended_at as "assignmentEndedAt",
            assignment.start_odometer::text as "startOdometer",
            assignment.end_odometer::text as "endOdometer",assignment.notes as "activityNotes",
            d.created_at as "createdAt",d.updated_at as "updatedAt"
     from deliveries d
     join orders o on o.id=d.order_id
     join customers c on c.id=o.customer_id
     join branches b on b.id=o.branch_id
     left join users verifier on verifier.id=d.allocation_verified_by
     left join lateral (
       select va.* from vehicle_assignments va
       where va.delivery_id=d.id and va.branch_id=o.branch_id
       order by va.created_at desc,va.id desc limit 1
     ) assignment on true
     left join employees assigned_driver on assigned_driver.id=assignment.driver_id
     left join vehicles v on v.id=assignment.vehicle_id
     where d.id=$1 and ($2::uuid is null or o.branch_id=$2)`,
    [deliveryId, branchScope ?? null],
  )
  return result.rows[0]
}

export async function getDeliveryDetailItems(client: PoolClient, deliveryId: string) {
  const result = await client.query<{
    id: string
    orderItemId: string
    productName: string
    sku: string
    unit: string
    quantity: string
    orderedQuantity: string
    inferredQuantity: string | null
  }>(
    `select di.id::text as id,oi.id::text as "orderItemId",p.name as "productName",
            p.sku,p.unit,di.quantity::text as quantity,oi.quantity::text as "orderedQuantity",
            di.inferred_quantity::text as "inferredQuantity"
     from delivery_items di
     join order_items oi on oi.id=di.order_item_id
     join products p on p.id=oi.product_id
     where di.delivery_id=$1
     order by p.name,oi.id,di.id`,
    [deliveryId],
  )
  return result.rows
}

export async function getDeliveryHistory(
  client: PoolClient,
  deliveryId: string,
  branchScope: string | undefined,
  page: number,
) {
  const condition = `a.entity_type='delivery' and a.entity_id=$1
    and ($2::uuid is null or a.branch_id=$2)`
  const parameters = [deliveryId, branchScope ?? null]
  const count = await client.query<{ total: string }>(
    `select count(*)::text as total from audit_logs a where ${condition}`,
    parameters,
  )
  const result = await client.query(
    `select a.id::text as id,a.action,a.old_value as "oldValue",a.new_value as "newValue",
            u.name as "actorName",a.created_at as "createdAt"
     from audit_logs a left join users u on u.id=a.user_id
     where ${condition}
     order by a.created_at desc,a.id desc limit $3 offset $4`,
    [...parameters, 25, (page - 1) * 25],
  )
  return { history: result.rows, historyTotal: Number(count.rows[0]?.total ?? 0) }
}

export async function findOrderForUpdate(client: PoolClient, orderId: string) {
  const result = await client.query<{ id: string; branchId: string; status: string }>(
    'select id, branch_id as "branchId", status from orders where id = $1 for update',
    [orderId],
  )
  return result.rows[0]
}

export async function getOrderIdForDelivery(client: PoolClient, deliveryId: string) {
  const result = await client.query<{ orderId: string }>(
    'select order_id::text as "orderId" from deliveries where id = $1',
    [deliveryId],
  )
  return result.rows[0]?.orderId
}

export async function hasActiveDelivery(client: PoolClient, orderId: string) {
  const result = await client.query<{ exists: boolean }>(
    "select exists(select 1 from deliveries where order_id = $1 and status <> 'Failed') as exists",
    [orderId],
  )
  return result.rows[0]?.exists ?? false
}

export async function insertDelivery(
  client: PoolClient,
  values: {
    reference: string
    orderId: string
    destination: string
    driverName: string | null
    scheduledAt: string | null
    status: string
  },
) {
  const result = await client.query<{ id: string }>(
    `insert into deliveries (reference, order_id, destination, driver_name, scheduled_at, status)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      values.reference,
      values.orderId,
      values.destination,
      values.driverName,
      values.scheduledAt,
      values.status,
    ],
  )
  return result.rows[0]?.id
}

export async function findDeliveryForUpdate(client: PoolClient, deliveryId: string) {
  const result = await client.query<{
    id: string
    orderId: string
    branchId: string
    reference: string
    status: string
  }>(
    `select d.id::text as id, d.order_id::text as "orderId", o.branch_id::text as "branchId", d.reference, d.status
       from deliveries d
       join orders o on o.id = d.order_id
      where d.id = $1
      for update of d`,
    [deliveryId],
  )
  return result.rows[0]
}

export async function updateDeliveryStatus(client: PoolClient, deliveryId: string, status: string) {
  await client.query('update deliveries set status = $2, updated_at = now() where id = $1', [
    deliveryId,
    status,
  ])
}

export async function insertDeliveryAuditLog(
  client: PoolClient,
  values: {
    userId: string
    branchId: string
    deliveryId: string
    reference: string | null
    action: string
    data: Record<string, unknown>
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    `insert into audit_logs (user_id, branch_id, action, entity_type, entity_id, new_value, ip_address, request_id)
     values ($1, $2, $3, 'delivery', $4, $5, $6, $7)`,
    [
      values.userId,
      values.branchId,
      values.action,
      values.deliveryId,
      { reference: values.reference, ...values.data },
      values.ipAddress,
      values.requestId,
    ],
  )
}
