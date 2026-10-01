import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/database/client.js'
import { createDelivery } from '@/features/deliveries/delivery.service.js'
import { cancelOrder, completeOrder } from '@/features/orders/order-lifecycle.service.js'
import {
  getLegacyDeliveryReconciliation,
  reconcileLegacyDelivery,
} from '@/features/orders/legacy-delivery.service.js'
import { reconcileLegacyDeliverySchema } from '@/features/orders/legacy-delivery.schemas.js'
import { getOrderDetail, placeOrder } from '@/features/orders/order.service.js'
import { requestReturn } from '@/features/orders/return.service.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

type LegacyFixture = { orderId: string; orderItemId: string; deliveryIds: string[] }

let actor: AuthenticatedUser
let branchId: string
let otherBranchId: string
let customerId: string
let productId: string
let baselineStock: string
let correction: LegacyFixture
let multiple: LegacyFixture
let completed: LegacyFixture
let returned: LegacyFixture
let zeroCorrection: LegacyFixture

const context = () => ({ user: actor, ipAddress: null, requestId: null })

async function insertId(sql: string, params: unknown[]) {
  const result = await pool.query<{ id: string }>(sql, params)
  const id = result.rows[0]?.id
  if (!id) throw new Error('Could not create a legacy reconciliation fixture.')
  return id
}

async function createLegacyFixture(
  orderedQuantity: string,
  status: string,
  deliveryQuantities: string[],
): Promise<LegacyFixture> {
  const orderId = await insertId(
    `insert into orders
       (order_number, customer_id, branch_id, total_amount, status, created_by, stock_mode)
     values ($1, $2, $3, $4, $5, $6, 'LegacyConsumed') returning id`,
    [
      `LEG-${randomUUID()}`,
      customerId,
      branchId,
      (Number(orderedQuantity) * 10).toFixed(2),
      status,
      actor.id,
    ],
  )
  const orderItemId = await insertId(
    `insert into order_items (order_id, product_id, quantity, unit_price, line_total)
     values ($1, $2, $3, '10.00', $4) returning id`,
    [orderId, productId, orderedQuantity, (Number(orderedQuantity) * 10).toFixed(2)],
  )
  const deliveryIds: string[] = []
  for (const quantity of deliveryQuantities) {
    const deliveryId = await insertId(
      `insert into deliveries (reference, order_id, destination, status)
       values ($1, $2, 'Historical site', 'Delivered') returning id`,
      [`LEG-DLV-${randomUUID()}`, orderId],
    )
    await pool.query(
      'insert into delivery_items (delivery_id, order_item_id, quantity) values ($1, $2, $3)',
      [deliveryId, orderItemId, quantity],
    )
    deliveryIds.push(deliveryId)
  }
  return { orderId, orderItemId, deliveryIds }
}

async function applyLegacyBackfillMarker() {
  const file = fileURLToPath(
    new URL('../../drizzle/0012_legacy_delivery_reconciliation.sql', import.meta.url),
  )
  const updates = readFileSync(file, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => /^UPDATE (delivery_items|deliveries)\b/.test(statement))
  expect(updates).toHaveLength(2)
  for (const update of updates) await pool.query(update)
}

beforeAll(async () => {
  const fixture = randomUUID().slice(0, 8)
  const roleId = await insertId('insert into roles (name) values ($1) returning id', [
    `Legacy review ${fixture}`,
  ])
  branchId = await insertId('insert into branches (name, code) values ($1, $2) returning id', [
    `Legacy branch ${fixture}`,
    `lg-${fixture}`,
  ])
  otherBranchId = await insertId('insert into branches (name, code) values ($1, $2) returning id', [
    `Other legacy branch ${fixture}`,
    `ol-${fixture}`,
  ])
  const userId = await insertId(
    `insert into users (email, name, password_hash, role_id, branch_id, status)
     values ($1, 'Legacy reviewer', 'unused-test-hash', $2, $3, 'Active') returning id`,
    [`legacy-review-${fixture}@example.invalid`, roleId, branchId],
  )
  customerId = await insertId(
    'insert into customers (name, branch_id) values ($1, $2) returning id',
    [`Legacy customer ${fixture}`, branchId],
  )
  productId = await insertId(
    `insert into products (name, sku, category, unit, unit_price)
     values ($1, $2, 'Materials', 'piece', '10.00') returning id`,
    [`Legacy product ${fixture}`, `LG-${fixture}`],
  )
  baselineStock = '20.000'
  await pool.query('insert into inventory (product_id, branch_id, quantity) values ($1, $2, $3)', [
    productId,
    branchId,
    baselineStock,
  ])
  actor = {
    id: userId,
    email: `legacy-review-${fixture}@example.invalid`,
    name: 'Legacy reviewer',
    role: `Legacy review ${fixture}`,
    branchId,
    branch: `Legacy branch ${fixture}`,
    isCrossBranch: false,
    permissions: [
      'sales.read',
      'orders.cancel',
      'orders.complete',
      'deliveries.update',
      'deliveries.create',
      'returns.create',
      'orders.create',
    ],
  }
  correction = await createLegacyFixture('2.000', 'Delivered', ['2.000'])
  multiple = await createLegacyFixture('2.000', 'Delivered', ['2.000', '2.000'])
  completed = await createLegacyFixture('1.000', 'Completed', ['1.000'])
  returned = await createLegacyFixture('1.000', 'Delivered', ['1.000'])
  zeroCorrection = await createLegacyFixture('1.000', 'Delivered', ['1.000'])
  await pool.query(
    `insert into order_returns
       (reference, request_key, order_id, delivery_id, reason, status, requested_by)
     values ($1, $2, $3, $4, 'Historical rejected return', 'Rejected', $5)`,
    [`RET-${randomUUID()}`, randomUUID(), returned.orderId, returned.deliveryIds[0], actor.id],
  )
  await applyLegacyBackfillMarker()
})

afterAll(async () => {
  await pool.end()
})

describe('legacy delivery allocation reconciliation', () => {
  it('marks inferred migration rows and blocks lifecycle until a scoped operator corrects them', async () => {
    const before = await getLegacyDeliveryReconciliation(correction.orderId, actor)
    expect(before.requiresReconciliation).toBe(true)
    expect(before.deliveries[0]).toMatchObject({
      allocationOrigin: 'LegacyBackfill',
      allocationStatus: 'Unverified',
      items: [{ quantity: '2.000', inferredQuantity: '2.000' }],
    })
    await expect(completeOrder(correction.orderId, context())).rejects.toMatchObject({
      code: 'LEGACY_DELIVERY_RECONCILIATION_REQUIRED',
    })
    await expect(
      cancelOrder(correction.orderId, { reason: 'customer request' }, context()),
    ).rejects.toMatchObject({ code: 'LEGACY_DELIVERY_RECONCILIATION_REQUIRED' })
    await expect(
      requestReturn(
        correction.orderId,
        {
          requestKey: randomUUID(),
          deliveryId: correction.deliveryIds[0]!,
          reason: 'Historical return',
          items: [{ orderItemId: correction.orderItemId, quantity: '1.000' }],
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'LEGACY_DELIVERY_RECONCILIATION_REQUIRED' })
    await expect(
      createDelivery(
        {
          orderId: correction.orderId,
          destination: 'Another site',
          items: [{ orderItemId: correction.orderItemId, quantity: '1.000' }],
        },
        { userId: actor.id, branchId, isCrossBranch: false, ipAddress: null, requestId: null },
      ),
    ).rejects.toMatchObject({ code: 'LEGACY_DELIVERY_RECONCILIATION_REQUIRED' })
    await expect(
      getLegacyDeliveryReconciliation(correction.orderId, { ...actor, branchId: otherBranchId }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' })
    await expect(
      getLegacyDeliveryReconciliation(correction.orderId, {
        ...actor,
        permissions: ['sales.read'],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const validNote = 'Confirmed against original signed delivery receipt.'
    expect(
      reconcileLegacyDeliverySchema.safeParse({
        note: validNote,
        items: [{ orderItemId: correction.orderItemId, quantity: '1.0001' }],
      }).success,
    ).toBe(false)
    await expect(
      reconcileLegacyDelivery(
        correction.orderId,
        correction.deliveryIds[0]!,
        { note: validNote, items: [{ orderItemId: multiple.orderItemId, quantity: '1.000' }] },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'RECONCILIATION_LINES_INVALID' })
    await expect(
      reconcileLegacyDelivery(
        correction.orderId,
        correction.deliveryIds[0]!,
        { note: validNote, items: [{ orderItemId: correction.orderItemId, quantity: '1.000' }] },
        { ...context(), user: { ...actor, branchId: otherBranchId } },
      ),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' })

    const result = await reconcileLegacyDelivery(
      correction.orderId,
      correction.deliveryIds[0]!,
      {
        note: validNote,
        items: [{ orderItemId: correction.orderItemId, quantity: '1.000' }],
      },
      context(),
    )
    expect(result).toMatchObject({
      allocationStatus: 'Verified',
      requiresReconciliation: false,
      items: [{ quantity: '1.000', inferredQuantity: '2.000' }],
    })
    const detail = await getOrderDetail(correction.orderId, actor)
    expect(detail.status).toBe('Partially Delivered')
    expect(detail.lifecycle.requiresLegacyDeliveryReconciliation).toBe(false)
    const stock = await pool.query<{ quantity: string }>(
      'select quantity::text as quantity from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    expect(stock.rows[0]?.quantity).toBe(baselineStock)
    const audit = await pool.query<{
      oldValue: { items: { quantity: string }[] }
      newValue: { items: { quantity: string }[] }
    }>(
      `select old_value as "oldValue", new_value as "newValue" from audit_logs
       where entity_type = 'delivery' and entity_id = $1
         and action = 'reconciled legacy delivery allocation'`,
      [correction.deliveryIds[0]],
    )
    expect(audit.rows[0]?.oldValue.items[0]?.quantity).toBe('2.000')
    expect(audit.rows[0]?.newValue.items[0]?.quantity).toBe('1.000')
  })

  it('allows staged correction of multiple inferred deliveries but rejects final overallocation', async () => {
    const note = 'Compared quantities with two independent delivery receipts.'
    const first = await reconcileLegacyDelivery(
      multiple.orderId,
      multiple.deliveryIds[0]!,
      { note, items: [{ orderItemId: multiple.orderItemId, quantity: '1.000' }] },
      context(),
    )
    expect(first.requiresReconciliation).toBe(true)
    await expect(
      reconcileLegacyDelivery(
        multiple.orderId,
        multiple.deliveryIds[1]!,
        { note, items: [{ orderItemId: multiple.orderItemId, quantity: '2.000' }] },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'DELIVERY_OVERALLOCATED' })
    const stillUnverified = await getLegacyDeliveryReconciliation(multiple.orderId, actor)
    expect(stillUnverified.deliveries[1]?.allocationStatus).toBe('Unverified')
    const second = await reconcileLegacyDelivery(
      multiple.orderId,
      multiple.deliveryIds[1]!,
      { note, items: [{ orderItemId: multiple.orderItemId, quantity: '1.000' }] },
      context(),
    )
    expect(second.requiresReconciliation).toBe(false)
    expect((await getOrderDetail(multiple.orderId, actor)).status).toBe('Delivered')
  })

  it('audits a correction to zero without writing a zero-quantity delivery row or stock', async () => {
    const result = await reconcileLegacyDelivery(
      zeroCorrection.orderId,
      zeroCorrection.deliveryIds[0]!,
      {
        note: 'Receipt confirms that the truck delivered no product.',
        items: [{ orderItemId: zeroCorrection.orderItemId, quantity: '0.000' }],
      },
      context(),
    )
    expect(result.items[0]).toMatchObject({ quantity: '0.000', inferredQuantity: null })
    const rows = await pool.query<{ count: string }>(
      'select count(*)::text as count from delivery_items where delivery_id = $1',
      [zeroCorrection.deliveryIds[0]],
    )
    expect(rows.rows[0]?.count).toBe('0')
    expect((await getOrderDetail(zeroCorrection.orderId, actor)).status).toBe('Processing')
    const stock = await pool.query<{ quantity: string }>(
      'select quantity::text as quantity from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    expect(stock.rows[0]?.quantity).toBe(baselineStock)
  })

  it('requires manual review for closed or return-linked corrections and leaves new orders unaffected', async () => {
    for (const fixture of [completed, returned]) {
      await expect(
        reconcileLegacyDelivery(
          fixture.orderId,
          fixture.deliveryIds[0]!,
          {
            note: 'Historical records indicate a different delivered amount.',
            items: [{ orderItemId: fixture.orderItemId, quantity: '0.500' }],
          },
          context(),
        ),
      ).rejects.toMatchObject({ code: 'HISTORICAL_ALLOCATION_REQUIRES_MANUAL_REVIEW' })
      const verified = await reconcileLegacyDelivery(
        fixture.orderId,
        fixture.deliveryIds[0]!,
        {
          note: 'Confirmed unchanged against the signed historical record.',
          items: [{ orderItemId: fixture.orderItemId, quantity: '1.000' }],
        },
        context(),
      )
      expect(verified.allocationStatus).toBe('Verified')
    }

    const newOrder = await placeOrder(
      { customerId, branchId, items: [{ productId, quantity: 1 }] },
      { userId: actor.id, customerBranchScope: branchId, ipAddress: null, requestId: null },
    )
    const view = await getLegacyDeliveryReconciliation(newOrder.id, actor)
    expect(view).toMatchObject({ stockMode: 'Reserved', requiresReconciliation: false })
    const detail = await getOrderDetail(newOrder.id, actor)
    expect(detail.lifecycle.requiresLegacyDeliveryReconciliation).toBe(false)
    await expect(
      createDelivery(
        {
          orderId: newOrder.id,
          destination: 'New recorded delivery site',
          items: [{ orderItemId: detail.items[0]!.id, quantity: '1.000' }],
        },
        { userId: actor.id, branchId, isCrossBranch: false, ipAddress: null, requestId: null },
      ),
    ).resolves.toMatchObject({ status: 'Preparing' })
  })
})
