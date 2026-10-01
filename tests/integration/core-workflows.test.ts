import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/database/client.js'
import { createModuleRecord, listModuleRecords } from '@/features/records/record.service.js'
import { getOrderDetail, placeOrder } from '@/features/orders/order.service.js'
import { recordPayment } from '@/features/payments/payment.service.js'
import {
  createDelivery,
  getDeliveryDetail,
  updateDeliveryStatus,
} from '@/features/deliveries/delivery.service.js'
import { requestRefund, approveRefund, processRefund } from '@/features/payments/refund.service.js'
import {
  requestReturn,
  approveReturn,
  receiveReturn,
  listOrderReturns,
} from '@/features/orders/return.service.js'
import { cancelOrder, completeOrder } from '@/features/orders/order-lifecycle.service.js'
import { createInventoryTransfer } from '@/features/inventory/inventory.service.js'
import { reviewExpense } from '@/features/expenses/expense.service.js'
import { generateReport } from '@/features/reports/reports.service.js'
import { createRole, deleteRole, updateRole } from '@/features/users/user.service.js'
import {
  confirmPayrollEntryReceived,
  createPayrollRun,
  getPayrollOptions,
  getPayrollRunDetail,
  markPayrollEntryPaid,
  processPayrollRun,
  updatePayrollRun,
} from '@/features/payroll/payroll.service.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

let branchId: string
let otherBranchId: string
let userId: string
let customerId: string
let productId: string
let user: AuthenticatedUser
const createdPayrollRunIds: string[] = []

async function insertId(query: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(query, values)
  const id = result.rows[0]?.id
  if (!id) throw new Error('An integration fixture could not be created.')
  return id
}

beforeAll(async () => {
  const fixture = randomUUID().slice(0, 8)
  const roleId = await insertId('insert into roles (name) values ($1) returning id', [
    `Integration role ${fixture}`,
  ])
  branchId = await insertId('insert into branches (name, code) values ($1, $2) returning id', [
    'Integration North',
    `it-n-${fixture}`,
  ])
  otherBranchId = await insertId('insert into branches (name, code) values ($1, $2) returning id', [
    'Integration South',
    `it-s-${fixture}`,
  ])
  userId = await insertId(
    `insert into users (email, name, password_hash, role_id, branch_id, status)
     values ($1, $2, $3, $4, $5, 'Active') returning id`,
    [
      `integration-${fixture}@example.invalid`,
      'Integration actor',
      'unused-test-hash',
      roleId,
      branchId,
    ],
  )
  customerId = await insertId(
    'insert into customers (name, branch_id) values ($1, $2) returning id',
    ['Integration customer', branchId],
  )
  productId = await insertId(
    `insert into products (name, sku, category, unit, unit_price)
     values ($1, $2, 'Materials', 'piece', '10.00') returning id`,
    ['Integration product', `IT-${fixture}`],
  )
  await pool.query('insert into inventory (product_id, branch_id, quantity) values ($1, $2, $3)', [
    productId,
    branchId,
    '5.000',
  ])
  user = {
    id: userId,
    name: 'Integration actor',
    email: `integration-${fixture}@example.invalid`,
    role: `Integration role ${fixture}`,
    branchId,
    branch: 'Integration North',
    isCrossBranch: false,
    permissions: ['expenses.create', 'payroll.read'],
  }
})

afterAll(async () => {
  if (createdPayrollRunIds.length) {
    await pool.query('delete from payroll_entries where payroll_run_id=any($1::uuid[])', [
      createdPayrollRunIds,
    ])
    await pool.query('delete from payroll_runs where id=any($1::uuid[])', [createdPayrollRunIds])
  }
  await pool.end()
})

describe('PostgreSQL business workflows', () => {
  it('replays payroll creation for the same actor and intent only', async () => {
    const employeeId = await insertId(
      `insert into employees(employee_number,name,position,branch_id)
       values($1,$2,$3,$4) returning id`,
      [`PAY-R-${randomUUID().slice(0, 8)}`, 'Payroll Replay Worker', 'Site worker', branchId],
    )
    const actor: AuthenticatedUser = {
      ...user,
      permissions: ['payroll.create'],
    }
    const context = { user: actor, ipAddress: null, requestId: null }
    const requestKey = randomUUID()
    const input = {
      branchId,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-15',
      requestKey,
      entries: [
        {
          employeeId,
          payBasis: 'Daily wage' as const,
          units: '10',
          rate: '100.00',
          adjustments: [
            {
              kind: 'earning' as const,
              type: 'Bonus' as const,
              amount: '50.00',
              notes: 'Site award',
            },
          ],
        },
      ],
    }

    const [first, replay] = await Promise.all([
      createPayrollRun(input, context),
      createPayrollRun(input, context),
    ])
    const runIds = [...new Set([first.id, replay.id])]
    createdPayrollRunIds.push(...runIds)
    try {
      expect(replay).toEqual(first)
      const count = await pool.query<{ count: string }>(
        'select count(*)::text as count from payroll_runs where request_key=$1',
        [requestKey],
      )
      expect(count.rows[0]?.count).toBe('1')

      await expect(
        createPayrollRun({ ...input, entries: [{ ...input.entries[0]!, units: '11' }] }, context),
      ).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT', status: 409 })

      const otherUserId = await insertId(
        `insert into users(email,name,password_hash,role_id,branch_id,status)
         select $1,'Payroll Replay Other Actor','unused-test-hash',role_id,branch_id,'Active'
         from users where id=$2 returning id`,
        [`payroll-replay-${randomUUID()}@example.invalid`, userId],
      )
      await expect(
        createPayrollRun(input, {
          ...context,
          user: { ...actor, id: otherUserId },
        }),
      ).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT', status: 409 })
    } finally {
      await pool.query('delete from payroll_entries where payroll_run_id=any($1::uuid[])', [runIds])
      await pool.query('delete from payroll_runs where id=any($1::uuid[])', [runIds])
      for (let index = createdPayrollRunIds.length - 1; index >= 0; index -= 1) {
        if (runIds.includes(createdPayrollRunIds[index]!)) createdPayrollRunIds.splice(index, 1)
      }
    }
  })

  it('keeps payroll detail, processing, payment, and receipt scoped to branch and grants', async () => {
    const employeeId = await insertId(
      `insert into employees(employee_number,name,position,branch_id)
       values($1,$2,$3,$4) returning id`,
      [`PAY-S-${randomUUID().slice(0, 8)}`, 'Payroll Scope Worker', 'Site worker', branchId],
    )
    const actor: AuthenticatedUser = {
      ...user,
      permissions: [
        'payroll.read',
        'payroll.create',
        'payroll.process',
        'payroll.pay',
        'payroll.receive',
      ],
    }
    const context = { user: actor, ipAddress: null, requestId: null }
    const input = {
      branchId,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-15',
      entries: [
        {
          employeeId,
          payBasis: 'Daily wage' as const,
          units: '1',
          rate: '100.00',
          adjustments: [],
        },
      ],
    }
    const run = await createPayrollRun(input, context)
    createdPayrollRunIds.push(run.id)
    try {
      const entryId = (await getPayrollRunDetail(run.id, actor)).entries[0]!.id
      const otherBranchContext = {
        ...context,
        user: { ...actor, branchId: otherBranchId, isCrossBranch: false },
      }
      await expect(getPayrollRunDetail(run.id, otherBranchContext.user)).rejects.toMatchObject({
        code: 'PAYROLL_RUN_NOT_FOUND',
        status: 404,
      })
      await expect(processPayrollRun(run.id, otherBranchContext)).rejects.toMatchObject({
        code: 'PAYROLL_RUN_NOT_FOUND',
        status: 404,
      })
      await expect(
        markPayrollEntryPaid(
          entryId,
          { paymentDate: new Date().toISOString().slice(0, 10), paymentMethod: 'Cash' },
          { ...context, user: { ...actor, permissions: ['payroll.read'] } },
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })

      await processPayrollRun(run.id, context)
      const payment = {
        paymentDate: new Date().toISOString().slice(0, 10),
        paymentMethod: 'Cash' as const,
        paymentReference: '',
      }
      await expect(
        markPayrollEntryPaid(entryId, payment, otherBranchContext),
      ).rejects.toMatchObject({
        code: 'PAYROLL_ENTRY_NOT_FOUND',
        status: 404,
      })
      await markPayrollEntryPaid(entryId, payment, context)

      const receipt = {
        receivedAt: new Date().toISOString(),
        acknowledgement: 'Employee confirmed the payment.',
      }
      await expect(
        confirmPayrollEntryReceived(entryId, receipt, {
          ...context,
          user: { ...actor, permissions: ['payroll.read'] },
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
      await expect(
        confirmPayrollEntryReceived(entryId, receipt, otherBranchContext),
      ).rejects.toMatchObject({ code: 'PAYROLL_ENTRY_NOT_FOUND', status: 404 })
      await confirmPayrollEntryReceived(entryId, receipt, context)
    } finally {
      await pool.query('delete from payroll_entries where payroll_run_id=$1', [run.id])
      await pool.query('delete from payroll_runs where id=$1', [run.id])
      createdPayrollRunIds.splice(createdPayrollRunIds.indexOf(run.id), 1)
    }
  })

  it('calculates and locks regular pay separately from optional additions and deductions', async () => {
    const employeeId = await insertId(
      `insert into employees(employee_number,name,position,branch_id)
       values($1,$2,$3,$4) returning id`,
      [`PAY-${randomUUID().slice(0, 8)}`, 'Payroll Test Worker', 'Site worker', branchId],
    )
    const actor: AuthenticatedUser = {
      ...user,
      permissions: [
        'payroll.read',
        'payroll.create',
        'payroll.update',
        'payroll.process',
        'payroll.pay',
        'payroll.receive',
      ],
    }
    const context = { user: actor, ipAddress: null, requestId: null }
    const input = {
      branchId,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-15',
      entries: [
        {
          employeeId,
          payBasis: 'Daily wage' as const,
          units: '10',
          rate: '100.00',
          adjustments: [
            { kind: 'earning' as const, type: 'Bonus' as const, amount: '50.00', notes: '' },
            {
              kind: 'deduction' as const,
              type: 'Cash advance recovery' as const,
              amount: '25.00',
              notes: '',
            },
          ],
        },
      ],
    }
    const created = await createPayrollRun(input, context)
    createdPayrollRunIds.push(created.id)
    expect(created.status).toBe('Draft')

    const draft = await getPayrollRunDetail(created.id, actor)
    expect(draft.entries[0]).toMatchObject({
      regularPay: '1000.00',
      additionalPay: '50.00',
      deductions: '25.00',
      grossPay: '1050.00',
      netPay: '1025.00',
      paymentStatus: 'Pending',
    })

    const editedInput = {
      ...input,
      entries: [
        {
          ...input.entries[0]!,
          adjustments: [
            ...input.entries[0]!.adjustments,
            {
              kind: 'earning' as const,
              type: 'Overtime' as const,
              amount: '20.00',
              notes: 'Site work',
            },
          ],
        },
      ],
    }
    await updatePayrollRun(created.id, editedInput, context)
    const edited = await getPayrollRunDetail(created.id, actor)
    expect(edited.entries[0]).toMatchObject({
      additionalPay: '70.00',
      grossPay: '1070.00',
      netPay: '1045.00',
      adjustments: expect.arrayContaining([
        expect.objectContaining({ type: 'Overtime', amount: '20.00', notes: 'Site work' }),
      ]),
    })

    await processPayrollRun(created.id, context)
    await expect(updatePayrollRun(created.id, editedInput, context)).rejects.toMatchObject({
      code: 'PAYROLL_RUN_LOCKED',
    })
    const entryId = edited.entries[0]!.id
    const paymentDate = new Date().toISOString().slice(0, 10)
    await markPayrollEntryPaid(
      entryId,
      { paymentDate, paymentMethod: 'Cash', paymentReference: 'PAYROLL TEST' },
      context,
    )
    await confirmPayrollEntryReceived(
      entryId,
      {
        receivedAt: new Date().toISOString(),
        acknowledgement: 'Employee confirmed receipt in person.',
      },
      context,
    )
    const received = await getPayrollRunDetail(created.id, actor)
    expect(received.entries[0]).toMatchObject({
      paymentStatus: 'Received',
      paymentMethod: 'Cash',
      acknowledgement: 'Employee confirmed receipt in person.',
    })
    await pool.query('delete from payroll_entries where payroll_run_id=$1', [created.id])
    await pool.query('delete from payroll_runs where id=$1', [created.id])
    createdPayrollRunIds.splice(createdPayrollRunIds.indexOf(created.id), 1)
  })

  it('keeps payroll mutations permission- and branch-scoped', async () => {
    const noCreate = {
      user: { ...user, permissions: ['payroll.read'] },
      ipAddress: null,
      requestId: null,
    }
    await expect(
      createPayrollRun(
        {
          branchId,
          periodStart: '2026-09-01',
          periodEnd: '2026-09-15',
          entries: [
            {
              employeeId: randomUUID(),
              payBasis: 'Salary',
              units: '1',
              rate: '1.00',
              adjustments: [],
            },
          ],
        },
        noCreate,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const crossBranch = {
      user: { ...user, permissions: ['payroll.create'], branchId: otherBranchId },
      ipAddress: null,
      requestId: null,
    }
    await expect(
      createPayrollRun(
        {
          branchId,
          periodStart: '2026-09-01',
          periodEnd: '2026-09-15',
          entries: [
            {
              employeeId: randomUUID(),
              payBasis: 'Salary',
              units: '1',
              rate: '1.00',
              adjustments: [],
            },
          ],
        },
        crossBranch,
      ),
    ).rejects.toMatchObject({ code: 'BRANCH_FORBIDDEN' })
  })

  it('rejects cross-branch payroll employees and scopes branch options', async () => {
    const localEmployeeId = await insertId(
      `insert into employees(employee_number,name,position,branch_id)
       values($1,$2,$3,$4) returning id`,
      [`PAY-L-${randomUUID().slice(0, 8)}`, 'Payroll local worker', 'Operator', branchId],
    )
    const foreignEmployeeId = await insertId(
      `insert into employees(employee_number,name,position,branch_id)
       values($1,$2,$3,$4) returning id`,
      [`PAY-F-${randomUUID().slice(0, 8)}`, 'Payroll foreign worker', 'Operator', otherBranchId],
    )
    const actor: AuthenticatedUser = {
      ...user,
      permissions: ['payroll.read', 'payroll.create', 'payroll.update'],
    }
    const context = { user: actor, ipAddress: null, requestId: null }
    const options = await getPayrollOptions(actor)
    expect(options.branches.map(({ id }) => id)).toEqual([branchId])
    expect(options.employees.map(({ id }) => id)).toContain(localEmployeeId)
    expect(options.employees.map(({ id }) => id)).not.toContain(foreignEmployeeId)
    await expect(getPayrollOptions(actor, otherBranchId)).rejects.toMatchObject({
      code: 'BRANCH_FORBIDDEN',
    })

    const input = {
      branchId,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-15',
      entries: [
        {
          employeeId: foreignEmployeeId,
          payBasis: 'Daily wage' as const,
          units: '1',
          rate: '100.00',
          adjustments: [],
        },
      ],
    }
    await expect(createPayrollRun(input, context)).rejects.toMatchObject({
      code: 'INVALID_PAYROLL_EMPLOYEE',
    })

    const validRun = await createPayrollRun(
      { ...input, entries: [{ ...input.entries[0]!, employeeId: localEmployeeId }] },
      context,
    )
    createdPayrollRunIds.push(validRun.id)
    await expect(updatePayrollRun(validRun.id, input, context)).rejects.toMatchObject({
      code: 'INVALID_PAYROLL_EMPLOYEE',
    })
    const unchanged = await getPayrollRunDetail(validRun.id, actor)
    expect(unchanged.entries).toMatchObject([{ employeeId: localEmployeeId }])

    const administrator = { ...actor, branchId: null, isCrossBranch: true }
    const allBranchOptions = await getPayrollOptions(administrator)
    expect(allBranchOptions.branches.map(({ id }) => id)).toContain(branchId)
    expect(allBranchOptions.branches.map(({ id }) => id)).toContain(otherBranchId)
    const foreignBranchOptions = await getPayrollOptions(administrator, otherBranchId)
    expect(foreignBranchOptions.employees.map(({ id }) => id)).toContain(foreignEmployeeId)
    await pool.query('delete from payroll_entries where payroll_run_id=$1', [validRun.id])
    await pool.query('delete from payroll_runs where id=$1', [validRun.id])
    createdPayrollRunIds.splice(createdPayrollRunIds.indexOf(validRun.id), 1)
  })

  it('rejects lifecycle mutations when the actor lacks action permissions', async () => {
    const unauthorizedContext = {
      user: { ...user, permissions: ['sales.read'] },
      ipAddress: null,
      requestId: null,
    }
    const unknownId = randomUUID()
    await expect(completeOrder(unknownId, unauthorizedContext)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      cancelOrder(unknownId, { reason: 'customer request' }, unauthorizedContext),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      requestRefund(
        unknownId,
        {
          requestKey: randomUUID(),
          paymentId: randomUUID(),
          amount: '1.00',
          method: 'Cash',
          reason: 'Unauthorized request',
        },
        unauthorizedContext,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(approveRefund(unknownId, unauthorizedContext)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(processRefund(unknownId, undefined, unauthorizedContext)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      requestReturn(
        unknownId,
        {
          requestKey: randomUUID(),
          deliveryId: unknownId,
          reason: 'Unauthorized request',
          items: [{ orderItemId: unknownId, quantity: '1.000' }],
        },
        unauthorizedContext,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(approveReturn(unknownId, unauthorizedContext)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      receiveReturn(unknownId, { items: [] }, unauthorizedContext),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('releases an untouched order reservation without increasing on-hand stock', async () => {
    const before = await pool.query<{ quantity: string; reservedQuantity: string }>(
      'select quantity::text as quantity, reserved_quantity::text as "reservedQuantity" from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    const order = await placeOrder(
      { customerId, branchId, items: [{ productId, quantity: 1 }] },
      { userId, customerBranchScope: branchId, ipAddress: null, requestId: null },
    )
    const lifecycleUser: AuthenticatedUser = {
      ...user,
      permissions: ['sales.read', 'orders.create', 'orders.cancel'],
    }
    await cancelOrder(
      order.id,
      { reason: 'customer request' },
      { user: lifecycleUser, ipAddress: null, requestId: null },
    )

    const after = await pool.query<{ quantity: string; reservedQuantity: string }>(
      'select quantity::text as quantity, reserved_quantity::text as "reservedQuantity" from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    expect(after.rows[0]).toEqual(before.rows[0])
    const movements = await pool.query<{ transaction_type: string }>(
      'select transaction_type from inventory_transactions where reference_type = $1 and reference_id = $2',
      ['Order', order.id],
    )
    expect(movements.rows.map((movement) => movement.transaction_type)).toEqual(
      expect.arrayContaining(['RESERVATION_CREATED', 'RESERVATION_RELEASED']),
    )
    expect(
      movements.rows.some((movement) => movement.transaction_type === 'ORDER_CANCELLATION_RESTOCK'),
    ).toBe(false)
  })

  it('delivers a partial quantity and releases only the remaining reservation when cancelled', async () => {
    const partialProductId = await insertId(
      `insert into products (name, sku, category, unit, unit_price)
       values ($1, $2, 'Materials', 'piece', '10.00') returning id`,
      ['Partial cancellation product', `PC-${randomUUID().slice(0, 8)}`],
    )
    await pool.query(
      'insert into inventory (product_id, branch_id, quantity) values ($1, $2, $3)',
      [partialProductId, branchId, '5.000'],
    )
    const before = await pool.query<{ quantity: string; reservedQuantity: string }>(
      'select quantity::text as quantity, reserved_quantity::text as "reservedQuantity" from inventory where product_id = $1 and branch_id = $2',
      [partialProductId, branchId],
    )
    const order = await placeOrder(
      { customerId, branchId, items: [{ productId: partialProductId, quantity: 2 }] },
      { userId, customerBranchScope: branchId, ipAddress: null, requestId: null },
    )
    const details = await getOrderDetail(order.id, { ...user, permissions: ['sales.read'] })
    const paymentContext = {
      userId,
      branchId,
      isCrossBranch: false,
      ipAddress: null,
      requestId: null,
    }
    const delivery = await createDelivery(
      {
        orderId: order.id,
        destination: 'Partial delivery cancellation site',
        items: [{ orderItemId: details.items[0]!.id, quantity: '1.000' }],
      },
      paymentContext,
    )
    const lifecycleUser: AuthenticatedUser = {
      ...user,
      permissions: ['sales.read', 'orders.create', 'orders.cancel'],
    }
    await updateDeliveryStatus(delivery.id, 'In Transit', paymentContext)
    await updateDeliveryStatus(delivery.id, 'Delivered', paymentContext)
    await expect(
      cancelOrder(
        order.id,
        { reason: 'customer request' },
        { user: lifecycleUser, ipAddress: null, requestId: null },
      ),
    ).rejects.toMatchObject({ code: 'RETURN_REQUIRED_BEFORE_CANCELLATION' })
    const afterDelivery = await pool.query<{ quantity: string; reservedQuantity: string }>(
      'select quantity::text as quantity, reserved_quantity::text as "reservedQuantity" from inventory where product_id = $1 and branch_id = $2',
      [partialProductId, branchId],
    )
    expect(afterDelivery.rows[0]).toEqual({
      quantity: (Number(before.rows[0]!.quantity) - 1).toFixed(3),
      reservedQuantity: (Number(before.rows[0]!.reservedQuantity) + 1).toFixed(3),
    })

    const result = await cancelOrder(
      order.id,
      {
        reason: 'customer request',
        items: [{ orderItemId: details.items[0]!.id, quantity: '1.000' }],
      },
      { user: lifecycleUser, ipAddress: null, requestId: null },
    )
    expect(result.status).toBe('Delivered')
    const afterCancellation = await pool.query<{ quantity: string; reservedQuantity: string }>(
      'select quantity::text as quantity, reserved_quantity::text as "reservedQuantity" from inventory where product_id = $1 and branch_id = $2',
      [partialProductId, branchId],
    )
    expect(afterCancellation.rows[0]).toEqual({
      quantity: afterDelivery.rows[0]!.quantity,
      reservedQuantity: before.rows[0]!.reservedQuantity,
    })
  })

  it('allows partial cancellation only after refunding the value removed from the order', async () => {
    const partialProductId = await insertId(
      `insert into products (name, sku, category, unit, unit_price)
       values ($1, $2, 'Materials', 'piece', '10.00') returning id`,
      ['Partial paid cancellation product', `PP-${randomUUID().slice(0, 8)}`],
    )
    await pool.query(
      'insert into inventory (product_id, branch_id, quantity) values ($1, $2, $3)',
      [partialProductId, branchId, '5.000'],
    )
    const order = await placeOrder(
      { customerId, branchId, items: [{ productId: partialProductId, quantity: 2 }] },
      { userId, customerBranchScope: branchId, ipAddress: null, requestId: null },
    )
    const lifecycleUser: AuthenticatedUser = {
      ...user,
      permissions: [
        'sales.read',
        'orders.create',
        'orders.cancel',
        'payments.create',
        'payments.refund.request',
        'payments.refund.approve',
        'payments.refund.process',
      ],
    }
    const context = { user: lifecycleUser, ipAddress: null, requestId: null }
    const paymentContext = {
      userId,
      branchId,
      isCrossBranch: false,
      ipAddress: null,
      requestId: null,
    }
    const payment = await recordPayment(
      { orderId: order.id, amount: '20.00', method: 'Cash' },
      paymentContext,
    )
    const detail = await getOrderDetail(order.id, lifecycleUser)
    const cancelInput = {
      reason: 'customer request',
      items: [{ orderItemId: detail.items[0]!.id, quantity: '1.000' }],
    }
    await expect(cancelOrder(order.id, cancelInput, context)).rejects.toMatchObject({
      code: 'PAYMENT_REFUND_REQUIRED',
      details: { requiredRefundAmount: '10.00' },
    })

    const refund = await requestRefund(
      order.id,
      {
        requestKey: randomUUID(),
        paymentId: payment.id,
        amount: '10.00',
        method: 'Cash',
        reason: 'Refund cancelled line value',
      },
      context,
    )
    await approveRefund(refund.id, context)
    await processRefund(refund.id, 'PARTIAL-CANCEL-REFUND-01', context)
    const cancelled = await cancelOrder(order.id, cancelInput, context)
    expect(cancelled.status).toBe('Processing')
    const updated = await getOrderDetail(order.id, lifecycleUser)
    expect(updated).toMatchObject({
      payableAmount: '10.00',
      paidAmount: '10.00',
      balance: '0.00',
      items: [{ cancelledQuantity: '1.000' }],
      payments: [expect.objectContaining({ amount: '20.00', status: 'Paid' })],
      refunds: [expect.objectContaining({ amount: '10.00', status: 'Processed' })],
    })
  })

  it('projects cancellation refunds from cumulative line rounding for fractional quantities', async () => {
    const fractionalProductId = await insertId(
      `insert into products (name, sku, category, unit, unit_price)
       values ($1, $2, 'Materials', 'metre', '0.01') returning id`,
      ['Fractional cancellation product', `FC-${randomUUID().slice(0, 8)}`],
    )
    await pool.query(
      'insert into inventory (product_id, branch_id, quantity) values ($1, $2, $3)',
      [fractionalProductId, branchId, '5.000'],
    )
    const order = await placeOrder(
      { customerId, branchId, items: [{ productId: fractionalProductId, quantity: 1.5 }] },
      { userId, customerBranchScope: branchId, ipAddress: null, requestId: null },
    )
    expect(order.totalAmount).toBe('0.02')
    const lifecycleUser = {
      ...user,
      permissions: ['sales.read', 'orders.cancel', 'payments.create'],
    }
    const context = { user: lifecycleUser, ipAddress: null, requestId: null }
    const detail = await getOrderDetail(order.id, lifecycleUser)
    const input = {
      reason: 'customer request',
      items: [{ orderItemId: detail.items[0]!.id, quantity: '0.500' }],
    }
    await cancelOrder(order.id, input, context)
    await recordPayment(
      { orderId: order.id, amount: '0.01', method: 'Cash' },
      { userId, branchId, isCrossBranch: false, ipAddress: null, requestId: null },
    )
    await cancelOrder(order.id, input, context)
    expect(await getOrderDetail(order.id, lifecycleUser)).toMatchObject({
      payableAmount: '0.01',
      paidAmount: '0.01',
      balance: '0.00',
      items: [{ cancelledQuantity: '1.000' }],
    })
    await expect(cancelOrder(order.id, input, context)).rejects.toMatchObject({
      code: 'PAYMENT_REFUND_REQUIRED',
      details: { requiredRefundAmount: '0.01', payableAfterCancellation: '0.00' },
    })
    const inventory = await pool.query<{ quantity: string; reservedQuantity: string }>(
      'select quantity::text as quantity, reserved_quantity::text as "reservedQuantity" from inventory where product_id = $1 and branch_id = $2',
      [fractionalProductId, branchId],
    )
    expect(inventory.rows[0]).toEqual({ quantity: '5.000', reservedQuantity: '0.500' })
  })

  it('persists an expense with the authenticated submitter, branch, and audit entry', async () => {
    const expense = await createModuleRecord(
      'expenses',
      { description: 'Integration fuel', category: 'Transport', amount: 125.5 },
      { user, ipAddress: null, requestId: null },
    )
    const saved = await pool.query<{ submitted_by: string; branch_id: string; amount: string }>(
      'select submitted_by, branch_id, amount from expenses where id = $1',
      [expense.id],
    )
    expect(saved.rows[0]).toMatchObject({ submitted_by: userId, branch_id: branchId })
    expect(saved.rows[0]?.amount).toBe('125.50')
    const audit = await pool.query<{ count: string }>(
      "select count(*)::text as count from audit_logs where entity_type = 'expenses' and entity_id = $1",
      [expense.id],
    )
    expect(audit.rows[0]?.count).toBe('1')
  })

  it('reserves stock and serializes payments without exceeding the order balance', async () => {
    const order = await placeOrder(
      { customerId, branchId, items: [{ productId, quantity: 2 }] },
      { userId, customerBranchScope: branchId, ipAddress: null, requestId: null },
    )
    expect(order.totalAmount).toBe('20.00')
    const orderReader = { ...user, permissions: ['sales.read', 'audit.read'] }
    const detail = await getOrderDetail(order.id, orderReader)
    expect(detail).toMatchObject({
      orderNumber: order.orderNumber,
      customerName: 'Integration customer',
      branchName: 'Integration North',
      status: 'Processing',
      totalAmount: '20.00',
      paidAmount: '0.00',
      balance: '20.00',
      items: [{ productName: 'Integration product', quantity: '2.000', unitPrice: '10.00' }],
      history: [{ action: 'created order' }],
    })
    await expect(getOrderDetail(order.id, { ...user, permissions: [] })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      getOrderDetail(order.id, { ...orderReader, branchId: otherBranchId }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' })
    const stock = await pool.query<{ quantity: string; reserved_quantity: string }>(
      'select quantity::text as quantity, reserved_quantity::text as reserved_quantity from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    expect(stock.rows[0]).toMatchObject({ quantity: '5.000', reserved_quantity: '2.000' })
    const ledger = await pool.query<{ transaction_type: string; quantity_delta: string }>(
      "select quantity_delta::text as quantity_delta from inventory_transactions where reference_type = 'Order' and reference_id = $1",
      [order.id],
    )
    expect(ledger.rows.map((row) => row.quantity_delta)).toEqual(['2.000'])

    const paymentContext = {
      userId,
      branchId,
      isCrossBranch: false,
      ipAddress: null,
      requestId: null,
    }
    await expect(
      recordPayment(
        { orderId: order.id, amount: '1.00', method: 'Cash' },
        { ...paymentContext, branchId: otherBranchId },
      ),
    ).rejects.toMatchObject({ code: 'BRANCH_FORBIDDEN' })

    const first = await recordPayment(
      { orderId: order.id, amount: '5.00', method: 'Cash' },
      paymentContext,
    )
    expect(first.remainingBalance).toBe('15.00')
    const competing = await Promise.allSettled([
      recordPayment({ orderId: order.id, amount: '10.00', method: 'Cash' }, paymentContext),
      recordPayment({ orderId: order.id, amount: '10.00', method: 'Cash' }, paymentContext),
    ])
    expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const delivery = await createDelivery(
      {
        orderId: order.id,
        destination: 'Integration job site',
        driverName: 'Test driver',
        items: [{ orderItemId: detail.items[0]!.id, quantity: '2.000' }],
      },
      paymentContext,
    )
    const deliveryReader = { ...user, permissions: ['deliveries.read', 'audit.read'] }
    const deliveryDetail = await getDeliveryDetail(delivery.id, deliveryReader)
    expect(deliveryDetail).toMatchObject({
      reference: delivery.reference,
      destination: 'Integration job site',
      status: 'Preparing',
      driverName: 'Test driver',
      orderNumber: order.orderNumber,
      orderStatus: 'Processing',
      customerName: 'Integration customer',
      branchName: 'Integration North',
      allocationOrigin: 'Recorded',
      allocationStatus: 'Verified',
      items: [
        {
          productName: 'Integration product',
          sku: expect.any(String),
          quantity: '2.000',
          orderedQuantity: '2.000',
          inferredQuantity: null,
        },
      ],
      history: [{ action: 'created delivery' }],
      historyTotal: 1,
    })
    expect(
      (
        await getDeliveryDetail(delivery.id, {
          ...deliveryReader,
          permissions: ['deliveries.read'],
        })
      ).history,
    ).toEqual([])
    await expect(
      getDeliveryDetail(delivery.id, { ...deliveryReader, branchId: otherBranchId }),
    ).rejects.toMatchObject({ code: 'DELIVERY_NOT_FOUND' })
    await expect(
      getDeliveryDetail(delivery.id, { ...deliveryReader, permissions: [] }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    const updatedDetail = await getOrderDetail(order.id, orderReader)
    expect(updatedDetail).toMatchObject({
      paidAmount: '15.00',
      balance: '5.00',
      payments: expect.arrayContaining([
        expect.objectContaining({ amount: '5.00', method: 'Cash', status: 'Paid' }),
      ]),
      deliveries: [
        expect.objectContaining({
          id: delivery.id,
          destination: 'Integration job site',
          driverName: 'Test driver',
          status: 'Preparing',
        }),
      ],
      stockMovements: [expect.objectContaining({ quantityDelta: '2.000' })],
    })
    const totalPaid = await pool.query<{ total: string }>(
      "select coalesce(sum(amount), 0)::text as total from payments where order_id = $1 and status = 'Paid'",
      [order.id],
    )
    expect(totalPaid.rows[0]?.total).toBe('15.00')
  })

  it('processes a returned-and-refunded order before cancelling its delivered quantity', async () => {
    const stockBeforeOrder = await pool.query<{ quantity: string }>(
      'select quantity::text as quantity from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    const lifecycleUser: AuthenticatedUser = {
      ...user,
      permissions: [
        'sales.read',
        'orders.create',
        'orders.cancel',
        'payments.create',
        'payments.refund.request',
        'payments.refund.approve',
        'payments.refund.process',
        'deliveries.create',
        'deliveries.update',
        'returns.create',
        'returns.approve',
        'returns.receive',
      ],
    }
    const order = await placeOrder(
      { customerId, branchId, items: [{ productId, quantity: 2 }] },
      { userId, customerBranchScope: branchId, ipAddress: null, requestId: null },
    )
    const context = { user: lifecycleUser, ipAddress: null, requestId: null }
    const paymentContext = {
      userId,
      branchId,
      isCrossBranch: false,
      ipAddress: null,
      requestId: null,
    }
    const payment = await recordPayment(
      { orderId: order.id, amount: '20.00', method: 'Cash' },
      paymentContext,
    )
    const details = await getOrderDetail(order.id, lifecycleUser)
    const delivery = await createDelivery(
      {
        orderId: order.id,
        destination: 'Return workflow job site',
        items: [{ orderItemId: details.items[0]!.id, quantity: '2.000' }],
      },
      paymentContext,
    )
    await updateDeliveryStatus(delivery.id, 'In Transit', paymentContext)
    await updateDeliveryStatus(delivery.id, 'Delivered', paymentContext)
    await expect(
      cancelOrder(
        order.id,
        {
          reason: 'customer request',
          items: [{ orderItemId: details.items[0]!.id, quantity: '2.000' }],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'CANCEL_EXCEEDS_REMAINING' })

    await expect(
      requestReturn(
        order.id,
        {
          requestKey: randomUUID(),
          deliveryId: delivery.id,
          reason: 'Return more than the delivery quantity',
          items: [{ orderItemId: details.items[0]!.id, quantity: '2.001' }],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'RETURN_EXCEEDS_DELIVERED_QUANTITY' })

    const returnRequest = await requestReturn(
      order.id,
      {
        requestKey: randomUUID(),
        deliveryId: delivery.id,
        reason: 'Customer returned unopened materials',
        items: [{ orderItemId: details.items[0]!.id, quantity: '1.000' }],
      },
      context,
    )
    await approveReturn(returnRequest.id, context)
    await receiveReturn(
      returnRequest.id,
      {
        items: [
          { orderItemId: details.items[0]!.id, condition: 'Resalable', acceptedQuantity: '1.000' },
        ],
      },
      context,
    )
    expect((await getOrderDetail(order.id, lifecycleUser)).status).toBe('Partially Delivered')
    await expect(
      receiveReturn(
        returnRequest.id,
        {
          items: [
            {
              orderItemId: details.items[0]!.id,
              condition: 'Resalable',
              acceptedQuantity: '1.000',
            },
          ],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'RETURN_NOT_APPROVED' })
    const returnStock = await pool.query<{ quantity: string }>(
      'select quantity::text as quantity from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    expect(Number(returnStock.rows[0]?.quantity)).toBe(
      Number(stockBeforeOrder.rows[0]?.quantity) - 1,
    )

    const damagedReturn = await requestReturn(
      order.id,
      {
        requestKey: randomUUID(),
        deliveryId: delivery.id,
        reason: 'Customer returned damaged materials',
        items: [{ orderItemId: details.items[0]!.id, quantity: '1.000' }],
      },
      context,
    )
    await approveReturn(damagedReturn.id, context)
    await receiveReturn(
      damagedReturn.id,
      {
        items: [
          { orderItemId: details.items[0]!.id, condition: 'Damaged', acceptedQuantity: '0.000' },
        ],
      },
      context,
    )
    expect((await getOrderDetail(order.id, lifecycleUser)).status).toBe('Processing')
    const damagedStock = await pool.query<{ quantity: string }>(
      'select quantity::text as quantity from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    expect(damagedStock.rows[0]?.quantity).toBe(returnStock.rows[0]?.quantity)

    const fullCancellation = {
      reason: 'customer request',
      items: [{ orderItemId: details.items[0]!.id, quantity: '2.000' }],
    }
    await expect(cancelOrder(order.id, fullCancellation, context)).rejects.toMatchObject({
      code: 'PAYMENT_REFUND_REQUIRED',
      details: { requiredRefundAmount: '20.00' },
    })

    const refund = await requestRefund(
      order.id,
      {
        requestKey: randomUUID(),
        paymentId: payment.id,
        amount: '8.00',
        method: 'Cash',
        reason: 'Partial refund for returned order',
      },
      context,
    )
    await expect(
      requestRefund(
        order.id,
        {
          requestKey: randomUUID(),
          paymentId: payment.id,
          amount: '12.01',
          method: 'Cash',
          reason: 'Attempt to exceed payment refund total',
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_PAYMENT' })
    await approveRefund(refund.id, context)
    await processRefund(refund.id, 'RETURN-WF-REFUND-PART-01', context)
    await expect(cancelOrder(order.id, fullCancellation, context)).rejects.toMatchObject({
      code: 'PAYMENT_REFUND_REQUIRED',
      details: { requiredRefundAmount: '12.00' },
    })
    const secondRefund = await requestRefund(
      order.id,
      {
        requestKey: randomUUID(),
        paymentId: payment.id,
        amount: '12.00',
        method: 'Cash',
        reason: 'Refund the remaining returned goods payment',
      },
      context,
    )
    await approveRefund(secondRefund.id, context)
    await processRefund(secondRefund.id, 'RETURN-WF-REFUND-02', context)
    await expect(
      requestRefund(
        order.id,
        {
          requestKey: randomUUID(),
          paymentId: payment.id,
          amount: '0.01',
          method: 'Cash',
          reason: 'Refund beyond remaining refundable amount',
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_PAYMENT' })
    const result = await cancelOrder(order.id, fullCancellation, context)
    expect(result.status).toBe('Cancelled')
    const detail = await getOrderDetail(order.id, lifecycleUser)
    expect(detail).toMatchObject({ status: 'Cancelled', paidAmount: '0.00', balance: '0.00' })
    expect(detail.payments).toEqual([expect.objectContaining({ amount: '20.00', status: 'Paid' })])
    expect(detail.refunds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'Processed', amount: '8.00' }),
        expect.objectContaining({ status: 'Processed', amount: '12.00' }),
      ]),
    )
    expect(detail.returns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'Received' }),
        expect.objectContaining({ status: 'Received' }),
      ]),
    )
  })

  it('records a mixed return and safely delivers a replacement', async () => {
    const replacementProductId = await insertId(
      `insert into products (name, sku, category, unit, unit_price)
       values ($1, $2, 'Materials', 'piece', '10.00') returning id`,
      ['Replacement product', `RP-${randomUUID().slice(0, 8)}`],
    )
    await pool.query(
      'insert into inventory (product_id, branch_id, quantity) values ($1, $2, $3)',
      [replacementProductId, branchId, '20.000'],
    )
    const lifecycleUser: AuthenticatedUser = {
      ...user,
      permissions: [
        'sales.read',
        'orders.create',
        'deliveries.create',
        'deliveries.update',
        'returns.create',
        'returns.approve',
        'returns.receive',
      ],
    }
    const context = { user: lifecycleUser, ipAddress: null, requestId: null }
    const deliveryContext = {
      userId,
      branchId,
      isCrossBranch: false,
      ipAddress: null,
      requestId: null,
    }
    const order = await placeOrder(
      { customerId, branchId, items: [{ productId: replacementProductId, quantity: 10 }] },
      { userId, customerBranchScope: branchId, ipAddress: null, requestId: null },
    )
    const orderItemId = (await getOrderDetail(order.id, lifecycleUser)).items[0]!.id
    const delivery = await createDelivery(
      {
        orderId: order.id,
        destination: 'Original job site',
        items: [{ orderItemId, quantity: '10.000' }],
      },
      deliveryContext,
    )
    await updateDeliveryStatus(delivery.id, 'In Transit', deliveryContext)
    await updateDeliveryStatus(delivery.id, 'Delivered', deliveryContext)
    expect((await getOrderDetail(order.id, lifecycleUser)).status).toBe('Delivered')

    const returned = await requestReturn(
      order.id,
      {
        requestKey: randomUUID(),
        deliveryId: delivery.id,
        reason: 'Customer returned mixed-condition goods',
        items: [{ orderItemId, quantity: '10.000' }],
      },
      context,
    )
    await approveReturn(returned.id, context)
    await expect(
      receiveReturn(
        returned.id,
        { items: [{ orderItemId, condition: 'Resalable', acceptedQuantity: '7.000' }] },
        context,
      ),
    ).rejects.toMatchObject({ code: 'RETURN_REMAINDER_CONDITION_INVALID' })
    await receiveReturn(
      returned.id,
      {
        items: [
          {
            orderItemId,
            condition: 'Resalable',
            acceptedQuantity: '7.000',
            remainderCondition: 'Damaged',
          },
        ],
      },
      context,
    )
    const receivedDetail = await getOrderDetail(order.id, lifecycleUser)
    expect(receivedDetail.status).toBe('Processing')
    expect(receivedDetail.returns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: returned.id,
          items: [
            expect.objectContaining({
              quantity: '10.000',
              condition: 'Resalable',
              acceptedQuantity: '7.000',
              remainderCondition: 'Damaged',
            }),
          ],
        }),
      ]),
    )
    expect((await listOrderReturns(order.id, lifecycleUser))[0]).toMatchObject({
      id: returned.id,
      items: [expect.objectContaining({ remainderCondition: 'Damaged' })],
    })
    const afterReturn = await pool.query<{ quantity: string; reservedQuantity: string }>(
      'select quantity::text as quantity, reserved_quantity::text as "reservedQuantity" from inventory where product_id = $1 and branch_id = $2',
      [replacementProductId, branchId],
    )
    expect(afterReturn.rows[0]).toEqual({ quantity: '17.000', reservedQuantity: '0.000' })

    const replacement = await createDelivery(
      {
        orderId: order.id,
        destination: 'Replacement at job site',
        items: [{ orderItemId, quantity: '10.000' }],
      },
      deliveryContext,
    )
    await updateDeliveryStatus(replacement.id, 'In Transit', deliveryContext)
    await updateDeliveryStatus(replacement.id, 'Delivered', deliveryContext)
    const finalDetail = await getOrderDetail(order.id, lifecycleUser)
    expect(finalDetail.status).toBe('Delivered')
    const finalStock = await pool.query<{ quantity: string; reservedQuantity: string }>(
      'select quantity::text as quantity, reserved_quantity::text as "reservedQuantity" from inventory where product_id = $1 and branch_id = $2',
      [replacementProductId, branchId],
    )
    expect(finalStock.rows[0]).toEqual({ quantity: '7.000', reservedQuantity: '0.000' })
    const restock = await pool.query<{ quantityDelta: string }>(
      `select quantity_delta::text as "quantityDelta" from inventory_transactions
       where reference_type = 'OrderReturn' and reference_id = $1 and transaction_type = 'RETURN_IN'`,
      [returned.id],
    )
    expect(restock.rows).toEqual([{ quantityDelta: '7.000' }])
  })

  it('completes only fully delivered and paid orders', async () => {
    const lifecycleUser: AuthenticatedUser = {
      ...user,
      permissions: [
        'sales.read',
        'orders.create',
        'orders.complete',
        'payments.create',
        'deliveries.create',
        'deliveries.update',
        'returns.create',
        'returns.approve',
        'returns.receive',
      ],
    }
    const order = await placeOrder(
      { customerId, branchId, items: [{ productId, quantity: 1 }] },
      { userId, customerBranchScope: branchId, ipAddress: null, requestId: null },
    )
    const context = { user: lifecycleUser, ipAddress: null, requestId: null }
    await expect(completeOrder(order.id, context)).rejects.toMatchObject({
      code: 'ORDER_NOT_FULLY_DELIVERED',
    })
    const paymentContext = {
      userId,
      branchId,
      isCrossBranch: false,
      ipAddress: null,
      requestId: null,
    }
    await recordPayment({ orderId: order.id, amount: '10.00', method: 'Cash' }, paymentContext)
    const details = await getOrderDetail(order.id, lifecycleUser)
    const delivery = await createDelivery(
      {
        orderId: order.id,
        destination: 'Completion workflow job site',
        items: [{ orderItemId: details.items[0]!.id, quantity: '1.000' }],
      },
      paymentContext,
    )
    await updateDeliveryStatus(delivery.id, 'In Transit', paymentContext)
    await updateDeliveryStatus(delivery.id, 'Delivered', paymentContext)
    await expect(completeOrder(order.id, context)).resolves.toMatchObject({ status: 'Completed' })
    const completedReturn = await requestReturn(
      order.id,
      {
        requestKey: randomUUID(),
        deliveryId: delivery.id,
        reason: 'Post-completion customer return',
        items: [{ orderItemId: details.items[0]!.id, quantity: '1.000' }],
      },
      context,
    )
    await approveReturn(completedReturn.id, context)
    await receiveReturn(
      completedReturn.id,
      {
        items: [
          { orderItemId: details.items[0]!.id, condition: 'Resalable', acceptedQuantity: '1.000' },
        ],
      },
      context,
    )
    expect((await getOrderDetail(order.id, lifecycleUser)).status).toBe('Completed')
    await expect(
      recordPayment({ orderId: order.id, amount: '1.00', method: 'Cash' }, paymentContext),
    ).rejects.toMatchObject({ code: 'ORDER_CLOSED' })
  })

  it('moves stock with paired ledger entries and rolls back an insufficient transfer', async () => {
    const before = await pool.query<{ quantity: string }>(
      'select quantity::text as quantity from inventory where product_id = $1 and branch_id = $2',
      [productId, branchId],
    )
    const sourceBefore = Number(before.rows[0]?.quantity)
    const transfer = await createInventoryTransfer(
      { fromBranchId: branchId, toBranchId: otherBranchId, items: [{ productId, quantity: 1 }] },
      { userId, ipAddress: null, requestId: null },
    )
    expect(transfer.status).toBe('Completed')
    const stock = await pool.query<{ branch_id: string; quantity: string }>(
      'select branch_id, quantity::text as quantity from inventory where product_id = $1',
      [productId],
    )
    expect(Number(stock.rows.find((row) => row.branch_id === branchId)?.quantity)).toBe(
      sourceBefore - 1,
    )
    expect(stock.rows.find((row) => row.branch_id === otherBranchId)?.quantity).toBe('1.000')
    const ledger = await pool.query<{ transaction_type: string; quantity_delta: string }>(
      `select transaction_type, quantity_delta::text as quantity_delta
       from inventory_transactions where reference_type = 'Transfer' and reference_id = $1
       order by transaction_type`,
      [transfer.id],
    )
    expect(ledger.rows).toEqual([
      { transaction_type: 'TRANSFER_IN', quantity_delta: '1.000' },
      { transaction_type: 'TRANSFER_OUT', quantity_delta: '-1.000' },
    ])
    const countBefore = await pool.query<{ count: string }>(
      'select count(*)::text as count from inventory_transfers',
    )
    await expect(
      createInventoryTransfer(
        {
          fromBranchId: branchId,
          toBranchId: otherBranchId,
          items: [{ productId, quantity: 100 }],
        },
        { userId, ipAddress: null, requestId: null },
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' })
    const countAfter = await pool.query<{ count: string }>(
      'select count(*)::text as count from inventory_transfers',
    )
    expect(countAfter.rows[0]?.count).toBe(countBefore.rows[0]?.count)
  })

  it('enforces branch-scoped expense review and report exports', async () => {
    const expense = await createModuleRecord(
      'expenses',
      { description: 'Review fuel', category: 'Transport', amount: 25 },
      { user, ipAddress: null, requestId: null },
    )
    const otherExpenseId = await insertId(
      `insert into expenses (description, category, branch_id, amount, submitted_by, status)
       values ('Other branch fuel', 'Transport', $1, 30, $2, 'Approved') returning id`,
      [otherBranchId, userId],
    )
    const reviewer = { ...user, permissions: [...user.permissions, 'expenses.approve'] }
    await expect(
      reviewExpense(
        otherExpenseId,
        { decision: 'Approved' },
        { user: reviewer, ipAddress: null, requestId: null },
      ),
    ).rejects.toMatchObject({ code: 'EXPENSE_NOT_FOUND' })
    const result = await reviewExpense(
      expense.id,
      { decision: 'Approved' },
      { user: reviewer, ipAddress: null, requestId: null },
    )
    expect(result.status).toBe('Approved')
    await expect(
      reviewExpense(
        expense.id,
        { decision: 'Approved' },
        { user: reviewer, ipAddress: null, requestId: null },
      ),
    ).rejects.toMatchObject({ code: 'EXPENSE_ALREADY_REVIEWED' })
    const stored = await pool.query<{ approved_by: string; status: string }>(
      'select approved_by, status from expenses where id = $1',
      [expense.id],
    )
    expect(stored.rows[0]).toMatchObject({ approved_by: userId, status: 'Approved' })

    const year = new Date().getUTCFullYear()
    const query = {
      report: 'approved-expenses' as const,
      dateFrom: `${year}-01-01`,
      dateTo: `${year}-12-31`,
    }
    await expect(generateReport(query, user, true)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const report = await generateReport(
      query,
      { ...reviewer, permissions: [...reviewer.permissions, 'reports.view', 'reports.export'] },
      true,
    )
    expect(report.rows).toMatchObject([
      {
        Branch: 'Integration North',
        Category: 'Transport',
        'Approved expenses': '1',
        'Total (PHP)': '25.00',
      },
    ])
    const exports = await pool.query<{ count: string }>(
      "select count(*)::text as count from audit_logs where action = 'exported report' and branch_id = $1",
      [branchId],
    )
    expect(exports.rows[0]?.count).toBe('1')
  })

  it('does not show global or other-branch payroll runs to a branch-scoped reader', async () => {
    await pool.query(
      `insert into payroll_runs (reference, period_start, period_end, branch_id)
       values ($1, '2026-09-01', '2026-09-15', $2),
              ($3, '2026-09-01', '2026-09-15', $4),
              ($5, '2026-09-01', '2026-09-15', null)`,
      [`PAY-N-${userId}`, branchId, `PAY-S-${userId}`, otherBranchId, `PAY-ALL-${userId}`],
    )
    const result = await listModuleRecords('payroll', user, {})
    expect(result.total).toBe(1)
    expect(result.data).toMatchObject([{ Branch: 'Integration North' }])
    const historicalRun = await pool.query<{ id: string }>(
      'select id from payroll_runs where reference=$1',
      [`PAY-N-${userId}`],
    )
    const historicalDetail = await getPayrollRunDetail(historicalRun.rows[0]!.id, user)
    expect(historicalDetail.entries).toEqual([])
  })

  it('persists role grants and rejects permission escalation', async () => {
    await pool.query(
      `insert into permissions (key, description)
       values ('reports.view', 'View reports'), ('reports.export', 'Export reports')
       on conflict (key) do nothing`,
    )
    const actor = {
      ...user,
      isCrossBranch: true,
      permissions: [...user.permissions, 'roles.create', 'roles.update', 'reports.view'],
    }
    const context = { user: actor, ipAddress: null, requestId: null }
    const role = await createRole(
      { name: `Integration viewer ${userId}`, permissions: ['reports.view'] },
      context,
    )
    const grants = await pool.query<{ permission_key: string }>(
      'select permission_key from role_permissions where role_id = $1',
      [role.id],
    )
    expect(grants.rows.map((row) => row.permission_key)).toEqual(['reports.view'])
    await expect(
      updateRole(role.id, { permissions: ['reports.export'] }, context),
    ).rejects.toMatchObject({ code: 'PERMISSION_ESCALATION' })
    await updateRole(role.id, { description: 'Approved viewer' }, context)
    const saved = await pool.query<{ description: string }>(
      'select description from roles where id = $1',
      [role.id],
    )
    expect(saved.rows[0]?.description).toBe('Approved viewer')
    await deleteRole(role.id, context)
    const deleted = await pool.query<{ count: string }>(
      'select count(*)::text as count from roles where id = $1',
      [role.id],
    )
    expect(deleted.rows[0]?.count).toBe('0')
  })
})
