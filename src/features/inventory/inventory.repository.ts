import type { PoolClient } from 'pg'
import { pool } from '@/database/client.js'

export async function getInventoryOptions(branchId?: string | null) {
  const [products, branches] = await Promise.all([
    pool.query<{ id: string; name: string; sku: string; unit: string }>(
      "select id, name, sku, unit from products where deleted_at is null and status = 'Active' order by name",
    ),
    pool.query<{ id: string; name: string }>(
      `select id, name from branches where deleted_at is null and status = 'Active'${
        branchId ? ' and id = $1' : ''
      } order by name`,
      branchId ? [branchId] : [],
    ),
  ])

  return { products: products.rows, branches: branches.rows }
}

export async function getInventoryTransferOptions() {
  const [products, branches] = await Promise.all([
    pool.query<{ id: string; name: string; sku: string; unit: string }>(
      "select id, name, sku, unit from products where deleted_at is null and status = 'Active' order by name",
    ),
    pool.query<{ id: string; name: string }>(
      "select id, name from branches where deleted_at is null and status = 'Active' order by name",
    ),
  ])

  return { products: products.rows, branches: branches.rows }
}

export async function findActiveTransferBranches(client: PoolClient, branchIds: [string, string]) {
  const result = await client.query<{ id: string }>(
    `select id from branches
     where id = any($1::uuid[]) and deleted_at is null and status = 'Active'
     order by id for share`,
    [branchIds],
  )

  return new Set(result.rows.map((branch) => branch.id))
}

export async function findActiveTransferProducts(client: PoolClient, productIds: string[]) {
  const result = await client.query<{ id: string }>(
    `select id from products
     where id = any($1::uuid[]) and deleted_at is null and status = 'Active'
     order by id for share`,
    [productIds],
  )

  return new Set(result.rows.map((product) => product.id))
}

export async function lockTransferRequest(client: PoolClient, requestKey: string) {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
    `inventory-transfer:${requestKey}`,
  ])
}

export async function findTransferRequest(client: PoolClient, requestKey: string) {
  const result = await client.query<{
    id: string
    reference: string
    status: string
    fromBranchId: string
    toBranchId: string
    requestedBy: string
    note: string | null
  }>(
    `select id::text as id,reference,status,from_branch_id::text as "fromBranchId",
            to_branch_id::text as "toBranchId",requested_by::text as "requestedBy",note
     from inventory_transfers where request_key=$1`,
    [requestKey],
  )
  const transfer = result.rows[0]
  if (!transfer) return undefined
  const items = await client.query<{ productId: string; quantity: string }>(
    `select product_id::text as "productId",quantity::text as quantity
     from inventory_transfer_items where transfer_id=$1 order by product_id`,
    [transfer.id],
  )
  return { ...transfer, items: items.rows }
}

export async function findInventoryTransfer(client: PoolClient, id: string, branchScope?: string) {
  const result = await client.query<{
    id: string
    reference: string
    status: string
    note: string | null
    fromBranchId: string
    fromBranchName: string
    toBranchId: string
    toBranchName: string
    requestedBy: string
    requestedByName: string | null
    createdAt: Date
  }>(
    `select t.id::text as id,t.reference,t.status,t.note,
            t.from_branch_id::text as "fromBranchId",f.name as "fromBranchName",
            t.to_branch_id::text as "toBranchId",d.name as "toBranchName",
            t.requested_by::text as "requestedBy",u.name as "requestedByName",
            t.created_at as "createdAt"
     from inventory_transfers t
     join branches f on f.id=t.from_branch_id
     join branches d on d.id=t.to_branch_id
     left join users u on u.id=t.requested_by
     where t.id=$1 and ($2::uuid is null or t.from_branch_id=$2 or t.to_branch_id=$2)`,
    [id, branchScope ?? null],
  )
  return result.rows[0]
}

export async function getInventoryTransferItems(client: PoolClient, transferId: string) {
  const result = await client.query<{
    id: string
    productId: string
    productName: string
    sku: string
    unit: string
    quantity: string
  }>(
    `select ti.id::text as id,ti.product_id::text as "productId",p.name as "productName",
            p.sku,p.unit,ti.quantity::text as quantity
     from inventory_transfer_items ti
     join products p on p.id=ti.product_id
     where ti.transfer_id=$1
     order by p.name,ti.id`,
    [transferId],
  )
  return result.rows
}

export async function getInventoryTransferHistory(
  client: PoolClient,
  transferId: string,
  branchScope: string | undefined,
  page: number,
) {
  const condition = `a.entity_type='inventory_transfer' and a.entity_id=$1
    and ($2::uuid is null or exists (
      select 1 from inventory_transfers t
      where t.id=a.entity_id and (t.from_branch_id=$2 or t.to_branch_id=$2)
        and a.branch_id in (t.from_branch_id,t.to_branch_id)
    ))`
  const parameters = [transferId, branchScope ?? null]
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

export async function lockTransferStock(
  client: PoolClient,
  productIds: string[],
  branchIds: [string, string],
) {
  // A consistent order also serializes opposing branch transfers without
  // each transaction holding a source row while waiting for its destination.
  await client.query(
    `select id from inventory
     where product_id=any($1::uuid[]) and branch_id=any($2::uuid[])
     order by product_id,branch_id for update`,
    [productIds, branchIds],
  )
}

export async function insertInventoryTransfer(
  client: PoolClient,
  values: {
    reference: string
    fromBranchId: string
    toBranchId: string
    requestedBy: string
    note: string | null
    requestKey: string | null
  },
) {
  const result = await client.query<{ id: string }>(
    `insert into inventory_transfers
       (reference, from_branch_id, to_branch_id, status, requested_by, note, request_key)
     values ($1, $2, $3, 'Completed', $4, $5, $6)
     returning id`,
    [
      values.reference,
      values.fromBranchId,
      values.toBranchId,
      values.requestedBy,
      values.note,
      values.requestKey,
    ],
  )

  return result.rows[0]?.id
}

export async function insertInventoryTransferItem(
  client: PoolClient,
  values: { transferId: string; productId: string; quantity: string },
) {
  await client.query(
    `insert into inventory_transfer_items (transfer_id, product_id, quantity)
     values ($1, $2, $3)`,
    [values.transferId, values.productId, values.quantity],
  )
}

export async function removeTransferredStock(
  client: PoolClient,
  values: { productId: string; branchId: string; quantity: string },
) {
  const result = await client.query<{ quantity: string }>(
    `update inventory
     set quantity = quantity - $3, updated_at = now()
     where product_id = $1 and branch_id = $2 and quantity - reserved_quantity >= $3
     returning quantity`,
    [values.productId, values.branchId, values.quantity],
  )

  return result.rows[0]
}

export async function addTransferredStock(
  client: PoolClient,
  values: { productId: string; branchId: string; quantity: string },
) {
  const result = await client.query<{ id: string }>(
    `insert into inventory (product_id, branch_id, quantity)
     values ($1, $2, $3)
     on conflict (product_id, branch_id) do update
       set quantity = inventory.quantity + excluded.quantity, updated_at = now()
       where inventory.quantity + excluded.quantity <= 99999999999.999
     returning id`,
    [values.productId, values.branchId, values.quantity],
  )
  return result.rows[0]
}

export async function insertTransferInventoryTransaction(
  client: PoolClient,
  values: {
    productId: string
    branchId: string
    transactionType: 'TRANSFER_OUT' | 'TRANSFER_IN'
    quantityDelta: string
    transferId: string
    note: string | null
    performedBy: string
  },
) {
  await client.query(
    `insert into inventory_transactions
       (product_id, branch_id, transaction_type, quantity_delta, reference_type, reference_id, note, performed_by)
     values ($1, $2, $3, $4, 'Transfer', $5, $6, $7)`,
    [
      values.productId,
      values.branchId,
      values.transactionType,
      values.quantityDelta,
      values.transferId,
      values.note,
      values.performedBy,
    ],
  )
}

export async function insertInventoryTransferAuditLog(
  client: PoolClient,
  values: {
    userId: string
    branchId: string
    transferId: string
    reference: string
    fromBranchId: string
    toBranchId: string
    items: { productId: string; quantity: string }[]
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    `insert into audit_logs
       (user_id, branch_id, action, entity_type, entity_id, new_value, ip_address, request_id)
     values ($1, $2, 'completed inventory transfer', 'inventory_transfer', $3, $4, $5, $6)`,
    [
      values.userId,
      values.branchId,
      values.transferId,
      {
        reference: values.reference,
        fromBranchId: values.fromBranchId,
        toBranchId: values.toBranchId,
        items: values.items,
        status: 'Completed',
      },
      values.ipAddress,
      values.requestId,
    ],
  )
}

export async function findActiveStockTarget(
  client: PoolClient,
  productId: string,
  branchId: string,
) {
  const result = await client.query<{ id: string }>(
    `select p.id from products p join branches b on b.id = $2
     where p.id = $1 and p.deleted_at is null and p.status = 'Active' and b.deleted_at is null and b.status = 'Active'
     for share of p,b`,
    [productId, branchId],
  )
  return result.rows[0]
}

export async function updateStockQuantity(
  client: PoolClient,
  productId: string,
  branchId: string,
  quantityDelta: string | number,
) {
  // A negative candidate INSERT fails its CHECK before ON CONFLICT can update
  // an existing row. Establish a zero row, then apply the signed UPDATE atomically.
  await client.query(
    `insert into inventory (product_id, branch_id, quantity)
     values ($1, $2, 0) on conflict (product_id, branch_id) do nothing`,
    [productId, branchId],
  )
  const result = await client.query<{ id: string; quantity: string; oldQuantity: string }>(
    `update inventory set quantity=quantity+$3, updated_at=clock_timestamp()
     where product_id=$1 and branch_id=$2 and quantity+$3 >= reserved_quantity
       and quantity+$3 <= 99999999999.999
     returning id::text as id, quantity::text as quantity, (quantity-$3)::text as "oldQuantity"`,
    [productId, branchId, quantityDelta],
  )
  return result.rows[0]
}

export async function insertInventoryTransaction(
  client: PoolClient,
  values: {
    productId: string
    branchId: string
    quantityDelta: string | number
    note: string | null
    performedBy: string
    requestKey: string | null
  },
) {
  const result = await client.query<{ id: string }>(
    `insert into inventory_transactions (product_id, branch_id, transaction_type, quantity_delta, note, performed_by,request_key,created_at)
     values ($1, $2, 'Adjustment', $3, $4, $5,$6,clock_timestamp()) returning id`,
    [
      values.productId,
      values.branchId,
      values.quantityDelta,
      values.note,
      values.performedBy,
      values.requestKey,
    ],
  )
  return result.rows[0]?.id
}

export async function insertInventoryAuditLog(
  client: PoolClient,
  values: {
    userId: string
    branchId: string
    productId: string
    inventoryId: string
    quantityDelta: string | number
    note: string | null
    quantity: string
    oldQuantity: string
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    `insert into audit_logs (user_id, branch_id, action, entity_type, entity_id, old_value,new_value, ip_address, request_id,created_at)
     values ($1, $2, 'adjusted inventory', 'inventory', $3, $4, $5, $6,$7,clock_timestamp())`,
    [
      values.userId,
      values.branchId,
      values.inventoryId,
      { quantity: values.oldQuantity },
      {
        quantityDelta: values.quantityDelta,
        note: values.note,
        quantity: values.quantity,
      },
      values.ipAddress,
      values.requestId,
    ],
  )
}

export async function lockAdjustmentRequest(client: PoolClient, requestKey: string) {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
    `inventory-adjustment:${requestKey}`,
  ])
}

export async function findAdjustmentRequest(client: PoolClient, requestKey: string) {
  const result = await client.query<{
    id: string
    productId: string
    branchId: string
    performedBy: string
    quantityDelta: string
    note: string | null
    quantity: string
    transactionType: string
  }>(
    `select it.id::text as id,it.product_id::text as "productId",it.branch_id::text as "branchId",
            it.performed_by::text as "performedBy",it.quantity_delta::text as "quantityDelta",it.note,i.quantity::text as quantity,it.transaction_type as "transactionType"
     from inventory_transactions it join inventory i on i.product_id=it.product_id and i.branch_id=it.branch_id
     where it.request_key=$1`,
    [requestKey],
  )
  return result.rows[0]
}
