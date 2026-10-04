import type { PoolClient } from 'pg'
import type { InventoryRecord } from './inventory-detail.repository.js'
import { quantityToMilli } from '@/shared/domain/fixed-point.js'

type Movement = {
  id: string
  transactionType: string
  quantityDelta: string
  referenceType: string | null
  referenceId: string | null
  note: string | null
  performedBy: string
}

export async function findLatestMovement(client: PoolClient, inventory: InventoryRecord) {
  const result = await client.query<Movement>(
    `select id::text as id, transaction_type as "transactionType",
            quantity_delta::text as "quantityDelta", reference_type as "referenceType",
            reference_id::text as "referenceId", note, performed_by::text as "performedBy"
     from inventory_transactions where product_id=$1 and branch_id=$2
     order by ledger_sequence desc limit 1`,
    [inventory.productId, inventory.branchId],
  )
  return result.rows[0]
}

export function isCorrectableAddition(movement: Movement | undefined) {
  return Boolean(
    movement &&
    movement.transactionType === 'Adjustment' &&
    movement.referenceType === null &&
    movement.referenceId === null &&
    quantityToMilli(movement.quantityDelta) > 0n,
  )
}

export async function findCorrectionRequest(client: PoolClient, requestKey: string) {
  const result = await client.query<
    Movement & {
      productId: string
      branchId: string
      originalQuantity: string | null
    }
  >(
    `select c.id::text as id,c.transaction_type as "transactionType",
            c.product_id::text as "productId",c.branch_id::text as "branchId",
            c.quantity_delta::text as "quantityDelta",c.reference_type as "referenceType",
            c.reference_id::text as "referenceId",c.note,c.performed_by::text as "performedBy",
            original.quantity_delta::text as "originalQuantity"
     from inventory_transactions c
     left join inventory_transactions original on c.reference_type='StockCorrection'
       and original.id=c.reference_id and original.product_id=c.product_id
       and original.branch_id=c.branch_id
     where c.request_key=$1`,
    [requestKey],
  )
  return result.rows[0]
}

export async function insertCorrection(
  client: PoolClient,
  inventory: InventoryRecord,
  values: {
    transactionId: string
    originalQuantity: string
    correctedQuantity: string
    quantityDelta: string
    reason: string
    requestKey: string
    userId: string
    quantity: string
    ipAddress: string | null
    requestId: string | null
  },
) {
  const result = await client.query<{ id: string }>(
    `insert into inventory_transactions
      (product_id,branch_id,transaction_type,quantity_delta,reference_type,reference_id,
       note,performed_by,request_key,created_at)
     values($1,$2,'Correction',$3,'StockCorrection',$4,$5,$6,$7,clock_timestamp()) returning id`,
    [
      inventory.productId,
      inventory.branchId,
      values.quantityDelta,
      values.transactionId,
      values.reason,
      values.userId,
      values.requestKey,
    ],
  )
  await client.query(
    `insert into audit_logs
      (user_id,branch_id,action,entity_type,entity_id,old_value,new_value,ip_address,request_id,created_at)
     values($1,$2,'corrected latest stock addition','inventory',$3,$4,$5,$6,$7,clock_timestamp())`,
    [
      values.userId,
      inventory.branchId,
      inventory.id,
      {
        transactionId: values.transactionId,
        additionQuantity: values.originalQuantity,
        quantity: inventory.quantity,
      },
      {
        transactionId: values.transactionId,
        correctionId: result.rows[0]!.id,
        additionQuantity: values.correctedQuantity,
        quantityDelta: values.quantityDelta,
        quantity: values.quantity,
        reason: values.reason,
      },
      values.ipAddress,
      values.requestId,
    ],
  )
  return { id: result.rows[0]!.id, quantity: values.quantity }
}
