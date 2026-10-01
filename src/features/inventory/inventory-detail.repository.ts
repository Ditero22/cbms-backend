import type { PoolClient } from 'pg'
import type { InventoryDetailQuery } from './inventory.schemas.js'

export const inventoryPageSize = 20

export type InventoryRecord = {
  id: string
  productId: string
  productName: string
  sku: string
  unit: string
  productStatus: string
  branchId: string
  branchName: string
  branchStatus: string
  quantity: string
  reservedQuantity: string
  availableQuantity: string
  reorderLevel: string
  status: string
  updatedAt: Date
}

export async function findInventoryRecord(
  client: PoolClient,
  id: string,
  branchScope?: string,
  lock = false,
) {
  const result = await client.query<InventoryRecord>(
    `select i.id::text as id, i.product_id::text as "productId", p.name as "productName",
            p.sku, p.unit, case when p.deleted_at is not null then 'Archived' else p.status end as "productStatus", i.branch_id::text as "branchId",
            b.name as "branchName", case when b.deleted_at is not null then 'Archived' else b.status end as "branchStatus",
            i.quantity::text as quantity, i.reserved_quantity::text as "reservedQuantity",
            (i.quantity - i.reserved_quantity)::text as "availableQuantity",
            i.reorder_level::text as "reorderLevel", i.updated_at as "updatedAt",
            case when i.quantity = 0 then 'Out of stock'
                 when i.quantity <= i.reorder_level then 'Low stock' else 'In stock' end as status
     from inventory i join products p on p.id=i.product_id join branches b on b.id=i.branch_id
     where i.id=$1 ${branchScope ? 'and i.branch_id=$2' : ''}
     ${lock ? 'for update of i' : ''}`,
    branchScope ? [id, branchScope] : [id],
  )
  return result.rows[0]
}

function movementFilters(inventory: InventoryRecord, query: InventoryDetailQuery) {
  const parameters: unknown[] = [inventory.productId, inventory.branchId]
  let sql = 'it.product_id=$1 and it.branch_id=$2'
  if (query.movementType) {
    parameters.push(query.movementType)
    sql += ` and it.transaction_type=$${parameters.length}`
  }
  if (query.dateFrom) {
    parameters.push(query.dateFrom)
    sql += ` and it.created_at >= ($${parameters.length}::date::timestamp at time zone 'Asia/Manila')`
  }
  if (query.dateTo) {
    parameters.push(query.dateTo)
    sql += ` and it.created_at < (($${parameters.length}::date + 1)::timestamp at time zone 'Asia/Manila')`
  }
  return { sql, parameters }
}

export async function getInventoryMovements(
  client: PoolClient,
  inventory: InventoryRecord,
  query: InventoryDetailQuery,
  permissions: readonly string[],
) {
  const { sql, parameters } = movementFilters(inventory, query)
  const count = await client.query<{ total: string }>(
    `select count(*)::text as total from inventory_transactions it where ${sql}`,
    parameters,
  )
  const orderAccess = permissions.includes('sales.read')
  const transferAccess = permissions.includes('inventory.transfer')
  const limit = parameters.length + 1
  const movement = await client.query(
    `select it.id::text as id, it.transaction_type as "transactionType",
            it.quantity_delta::text as "quantityDelta",
            case when it.transaction_type in ('RESERVATION_CREATED','RESERVATION_RELEASED') then '0.000'
                 when it.transaction_type in ('DELIVERY_OUT','Adjustment','Correction','TRANSFER_IN','TRANSFER_OUT','RETURN_IN','ORDER_CANCELLATION_RESTOCK') then it.quantity_delta::text
                 else null end as "stockDelta",
            case when it.transaction_type in ('RESERVATION_CREATED','RESERVATION_RELEASED','DELIVERY_OUT') then it.quantity_delta::text
                 when it.transaction_type in ('Adjustment','Correction','TRANSFER_IN','TRANSFER_OUT','RETURN_IN','ORDER_CANCELLATION_RESTOCK') then '0.000'
                 else null end as "reservedDelta",
            it.reference_type as "referenceType",
            case when it.reference_type='StockCorrection' and original.id is not null then it.reference_id::text
                 when (it.reference_type='Order' and ${orderAccess} and o.id is not null)
                       or (it.reference_type='OrderReturn' and ${orderAccess} and r.id is not null)
                       or (it.reference_type='Transfer' and ${transferAccess} and t.id is not null)
                 then coalesce(o.id,r.id,t.id)::text else null end as "referenceId",
            case when it.reference_type='StockCorrection' and original.id is not null then 'Stock correction'
                 when it.reference_type='Order' and ${orderAccess} then o.order_number
                 when it.reference_type='OrderReturn' and ${orderAccess} then r.reference
                 when it.reference_type='Transfer' and ${transferAccess} then t.reference
                 else null end as "referenceLabel",
            it.note, u.name as "performedByName", it.created_at as "createdAt"
     from inventory_transactions it join users u on u.id=it.performed_by
     left join orders o on it.reference_type='Order' and o.id=it.reference_id and o.branch_id=it.branch_id
     left join order_returns r on it.reference_type='OrderReturn' and r.id=it.reference_id
       and exists(select 1 from orders ro where ro.id=r.order_id and ro.branch_id=it.branch_id)
     left join inventory_transfers t on it.reference_type='Transfer' and t.id=it.reference_id
       and (t.from_branch_id=it.branch_id or t.to_branch_id=it.branch_id)
     left join inventory_transactions original on it.reference_type='StockCorrection'
       and original.id=it.reference_id and original.product_id=it.product_id and original.branch_id=it.branch_id
     where ${sql} order by it.created_at desc,it.id desc limit $${limit} offset $${limit + 1}`,
    [...parameters, inventoryPageSize, (query.movementPage - 1) * inventoryPageSize],
  )
  const types = await client.query<{ transactionType: string }>(
    `select distinct transaction_type as "transactionType" from inventory_transactions
     where product_id=$1 and branch_id=$2 order by transaction_type`,
    [inventory.productId, inventory.branchId],
  )
  return {
    movements: movement.rows,
    movementTotal: Number(count.rows[0]?.total ?? 0),
    movementTypes: types.rows.map((row) => row.transactionType),
  }
}

export async function getInventoryHistory(
  client: PoolClient,
  inventory: InventoryRecord,
  page: number,
) {
  // Earlier adjustment audits used the product ID. Keep those visible only in
  // this row's branch while new writes identify the inventory row itself.
  const parameters = [inventory.id, inventory.productId, inventory.branchId]
  const condition = `a.entity_type='inventory' and a.entity_id in ($1::uuid,$2::uuid) and a.branch_id=$3`
  const count = await client.query<{ total: string }>(
    `select count(*)::text as total from audit_logs a where ${condition}`,
    parameters,
  )
  const result = await client.query(
    `select a.id::text as id, a.action, a.old_value as "oldValue", a.new_value as "newValue",
            u.name as "actorName", a.created_at as "createdAt"
     from audit_logs a left join users u on u.id=a.user_id where ${condition}
     order by a.created_at desc,a.id desc limit $4 offset $5`,
    [...parameters, inventoryPageSize, (page - 1) * inventoryPageSize],
  )
  return { history: result.rows, historyTotal: Number(count.rows[0]?.total ?? 0) }
}

export async function setInventoryReorder(client: PoolClient, id: string, reorderLevel: string) {
  await client.query(
    'update inventory set reorder_level=$2, updated_at=clock_timestamp() where id=$1',
    [id, reorderLevel],
  )
}

export async function insertInventoryReorderAudit(
  client: PoolClient,
  input: {
    inventory: InventoryRecord
    reorderLevel: string
    userId: string
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    `insert into audit_logs(user_id,branch_id,action,entity_type,entity_id,old_value,new_value,ip_address,request_id,created_at)
     values($1,$2,'updated inventory reorder point','inventory',$3,$4,$5,$6,$7,clock_timestamp())`,
    [
      input.userId,
      input.inventory.branchId,
      input.inventory.id,
      { reorderLevel: input.inventory.reorderLevel },
      { reorderLevel: input.reorderLevel },
      input.ipAddress,
      input.requestId,
    ],
  )
}
