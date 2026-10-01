import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '@/app.js'
import { pool } from '@/database/client.js'
import {
  createSessionToken,
  hashSessionToken,
  sessionCookieName,
} from '@/shared/security/session.js'

type Dependency = { key: string; label: string; count: number; blockingCount: number }
type Policy = {
  permanentDeletionAllowed: false
  canArchive: boolean
  dependencies: Dependency[]
}
type Detail = { id: string; archivePolicy?: Policy }
type Failure = { error: { code: string; message: string; details: { dependencies: Dependency[] } } }
type Account = { id: string; cookie: string }
type Module = 'branches' | 'products'

const fixture = randomUUID().slice(0, 8)
const accounts: Record<string, Account> = {}
const grants = [
  'branches.read',
  'branches.update',
  'products.read',
  'products.update',
  'employees.read',
  'employees.update',
  'customers.update',
]
let server: Server
let apiUrl: string
let assignedBranchId: string

async function insertId(sql: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(sql, values)
  const id = result.rows[0]?.id
  if (!id) throw new Error('Could not create archive dependency acceptance fixture.')
  return id
}

async function branch(label: string) {
  return insertId('insert into branches (name,code) values ($1,$2) returning id', [
    `Archive ${label} ${fixture}`,
    `arch-${randomUUID().slice(0, 12)}`,
  ])
}

async function product(label: string) {
  return insertId(
    `insert into products (name,sku,category,unit,unit_price)
     values ($1,$2,'Materials','piece','10.00') returning id`,
    [`Archive ${label} ${fixture}`, `ARCH-${randomUUID()}`],
  )
}

async function account(label: string, branchId: string | null, keys: string[], system: boolean) {
  const roleId = await insertId('insert into roles (name,is_system) values ($1,$2) returning id', [
    `Archive ${label} ${fixture}`,
    system ? 1 : 0,
  ])
  for (const key of keys)
    await pool.query('insert into role_permissions (role_id,permission_key) values ($1,$2)', [
      roleId,
      key,
    ])
  const id = await insertId(
    `insert into users (name,email,password_hash,role_id,branch_id,is_cross_branch)
     values ($1,$2,'unused-test-hash',$3,$4,$5) returning id`,
    [
      `Archive ${label}`,
      `archive-${label}-${fixture}@example.invalid`,
      roleId,
      branchId,
      system ? 1 : 0,
    ],
  )
  const token = createSessionToken()
  await pool.query(
    `insert into user_sessions (user_id,token_hash,expires_at)
     values ($1,$2,now()+interval '1 hour')`,
    [id, hashSessionToken(token)],
  )
  accounts[label] = { id, cookie: `${sessionCookieName}=${token}` }
}

async function request<T>(
  method: string,
  path: string,
  actor = 'admin',
  body?: Record<string, unknown>,
) {
  const response = await fetch(`${apiUrl}/api/v1${path}`, {
    method,
    headers: {
      Cookie: accounts[actor]!.cookie,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: (await response.json()) as T }
}

async function policy(module: Module, id: string) {
  const detail = await request<Detail>('GET', `/${module}/${id}`)
  expect(detail.status).toBe(200)
  expect(detail.body.archivePolicy?.permanentDeletionAllowed).toBe(false)
  return detail.body.archivePolicy!
}

async function expectBlocked(module: Module, id: string, keys: string[], deactivate = false) {
  const result = await request<Failure>(
    'PATCH',
    `/${module}/${id}${deactivate ? '' : '/archive'}`,
    'admin',
    deactivate ? { status: 'Inactive' } : {},
  )
  expect(result.status).toBe(409)
  expect(result.body.error.code).toBe('RECORD_IN_USE')
  expect(result.body.error.details.dependencies.map(({ key }) => key)).toEqual(
    expect.arrayContaining(keys),
  )
  for (const key of keys) {
    const dependency = result.body.error.details.dependencies.find((entry) => entry.key === key)!
    expect(dependency.blockingCount).toBeGreaterThan(0)
    expect(result.body.error.message).toContain(`${dependency.label}: ${dependency.blockingCount}`)
  }
  expect(result.body.error.message).toContain('Historical records will be retained')
}

async function completedOrder(branchId: string, productId: string) {
  const customerId = await insertId(
    "insert into customers (name,branch_id,status) values ($1,$2,'Inactive') returning id",
    [`Archive historical customer ${randomUUID()}`, branchId],
  )
  const orderId = await insertId(
    `insert into orders (order_number,customer_id,branch_id,total_amount,status,created_by)
     values ($1,$2,$3,'10.00','Completed',$4) returning id`,
    [`ARCH-O-${randomUUID()}`, customerId, branchId, accounts.admin!.id],
  )
  const orderItemId = await insertId(
    `insert into order_items (order_id,product_id,quantity,unit_price,line_total)
     values ($1,$2,1,'10.00','10.00') returning id`,
    [orderId, productId],
  )
  const deliveryId = await insertId(
    `insert into deliveries (reference,order_id,destination,status)
     values ($1,$2,'Historical destination','Delivered') returning id`,
    [`ARCH-D-${randomUUID()}`, orderId],
  )
  const deliveryItemId = await insertId(
    'insert into delivery_items (delivery_id,order_item_id,quantity) values ($1,$2,1) returning id',
    [deliveryId, orderItemId],
  )
  return { customerId, orderId, orderItemId, deliveryId, deliveryItemId }
}

async function payroll(branchId: string, status: 'Pending' | 'Paid' | 'Received') {
  const employeeId = await insertId(
    `insert into employees (employee_number,name,position,branch_id,status)
     values ($1,'Historical payroll worker','Site worker',$2,'Inactive') returning id`,
    [`ARCH-E-${randomUUID()}`, branchId],
  )
  const runId = await insertId(
    `insert into payroll_runs (reference,period_start,period_end,branch_id,status,employee_count,gross_pay)
     values ($1,'2020-10-01','2020-10-15',$2,'Processed',1,'100.00') returning id`,
    [`ARCH-PAY-${randomUUID()}`, branchId],
  )
  const entryId = await insertId(
    `insert into payroll_entries
     (payroll_run_id,employee_id,branch_id,employee_number,employee_name,position,pay_basis,
      units,rate,regular_pay,gross_pay,net_pay,payment_status,payment_date,payment_method,
      paid_by,paid_at,received_at,confirmed_by)
     values ($1,$2,$3,'Historical employee','Historical worker','Site worker','Salary',
      1,'100.00','100.00','100.00','100.00',$4,
      case when $4='Pending' then null else '2020-10-16'::date end,
      case when $4='Pending' then null else 'Cash' end,
      case when $4='Pending' then null else $5::uuid end,
      case when $4='Pending' then null else now() end,
      case when $4='Received' then now() else null end,
      case when $4='Received' then $5::uuid else null end) returning id`,
    [runId, employeeId, branchId, status, accounts.admin!.id],
  )
  return { employeeId, runId, entryId }
}

beforeAll(async () => {
  for (const key of grants)
    await pool.query(
      'insert into permissions (key,description) values ($1,$1) on conflict do nothing',
      [key],
    )
  assignedBranchId = await branch('assigned')
  await account('admin', null, grants, true)
  await account('reader', null, ['branches.read', 'products.read'], true)
  await account('branch', assignedBranchId, grants, false)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Archive dependency acceptance server did not listen.')
  apiUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  await pool.end()
})

describe('managed record dependency-aware soft archive', () => {
  it('exposes archive policy only to editors and preserves branch scope and archive grants', async () => {
    const branchId = await branch('grants')
    const productId = await product('grants')
    for (const [module, id] of [
      ['branches', branchId],
      ['products', productId],
    ] as const) {
      const reader = await request<Detail>('GET', `/${module}/${id}`, 'reader')
      expect(reader.status).toBe(200)
      expect(reader.body).not.toHaveProperty('archivePolicy')
      expect((await request('PATCH', `/${module}/${id}/archive`, 'reader', {})).status).toBe(403)
      expect((await request('DELETE', `/${module}/${id}`, 'admin')).status).toBe(404)
      expect((await policy(module, id)).canArchive).toBe(true)
    }
    expect((await request('GET', `/branches/${branchId}`, 'branch')).status).toBe(403)
    expect((await request('PATCH', `/branches/${branchId}/archive`, 'branch', {})).status).toBe(403)
  })

  it('prevents reactivating assigned customers or employees after their branch is archived', async () => {
    const branchId = await branch('reactivation')
    const customerId = await insertId(
      "insert into customers (name,branch_id,status) values ('Inactive customer',$1,'Inactive') returning id",
      [branchId],
    )
    const employeeId = await insertId(
      `insert into employees (employee_number,name,position,branch_id,status)
       values ($1,'Inactive worker','Site worker',$2,'Inactive') returning id`,
      [`ARCH-REACTIVATE-${randomUUID()}`, branchId],
    )
    expect((await request('PATCH', `/branches/${branchId}/archive`, 'admin', {})).status).toBe(200)
    for (const [module, id] of [
      ['customers', customerId],
      ['employees', employeeId],
    ]) {
      const denied = await request<Failure>('PATCH', `/${module}/${id}`, 'admin', {
        status: 'Active',
      })
      expect(denied.status).toBe(400)
      expect(denied.body.error.code).toBe('INVALID_BRANCH')
    }
    const customer = await pool.query('select status,branch_id from customers where id=$1', [
      customerId,
    ])
    const employee = await pool.query('select status,branch_id from employees where id=$1', [
      employeeId,
    ])
    expect(customer.rows).toEqual([{ status: 'Inactive', branch_id: branchId }])
    expect(employee.rows).toEqual([{ status: 'Inactive', branch_id: branchId }])
    const unassignedId = await insertId(
      "insert into customers (name,status) values ('Unassigned inactive customer','Inactive') returning id",
      [],
    )
    expect(
      (await request('PATCH', `/customers/${unassignedId}`, 'admin', { status: 'Active' })).status,
    ).toBe(200)
  })

  it('blocks branch archive and deactivation for owned customers, vehicles, and pending expenses', async () => {
    const branchId = await branch('operational')
    const customerId = await insertId(
      'insert into customers (name,branch_id) values ($1,$2) returning id',
      [`Archive active customer ${fixture}`, branchId],
    )
    const vehicleId = await insertId(
      `insert into vehicles (name,plate_number,vehicle_type,branch_id)
       values ('Archive vehicle',$1,'Truck',$2) returning id`,
      [`ARCH-V-${randomUUID()}`, branchId],
    )
    const expenseId = await insertId(
      `insert into expenses (description,category,branch_id,submitted_by,amount)
       values ('Unreviewed expense','Materials',$1,$2,'10.00') returning id`,
      [branchId, accounts.admin!.id],
    )
    const blocked = await policy('branches', branchId)
    expect(blocked.canArchive).toBe(false)
    expect(blocked.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'customers', count: 1, blockingCount: 1 }),
        expect.objectContaining({ key: 'vehicles', count: 1, blockingCount: 1 }),
        expect.objectContaining({ key: 'expenses', count: 1, blockingCount: 1 }),
      ]),
    )
    await expectBlocked('branches', branchId, ['customers', 'vehicles', 'expenses'])
    await expectBlocked('branches', branchId, ['customers', 'vehicles', 'expenses'], true)
    const unchanged = await pool.query<{ status: string; deletedAt: Date | null }>(
      'select status,deleted_at as "deletedAt" from branches where id=$1',
      [branchId],
    )
    expect(unchanged.rows).toEqual([{ status: 'Active', deletedAt: null }])

    await pool.query("update customers set status='Inactive' where id=$1", [customerId])
    await pool.query('update vehicles set deleted_at=now(),deleted_by=$2 where id=$1', [
      vehicleId,
      accounts.admin!.id,
    ])
    await pool.query(
      "update expenses set status='Approved',approved_by=$2,approved_at=now() where id=$1",
      [expenseId, accounts.admin!.id],
    )
    expect((await policy('branches', branchId)).canArchive).toBe(true)
    expect(
      (await request('PATCH', `/branches/${branchId}`, 'admin', { status: 'Inactive' })).status,
    ).toBe(200)
    expect((await request('PATCH', `/branches/${branchId}/archive`, 'admin', {})).status).toBe(200)
    expect(
      (await pool.query('select branch_id from customers where id=$1', [customerId])).rows,
    ).toEqual([{ branch_id: branchId }])
    expect(
      (await pool.query('select branch_id from vehicles where id=$1', [vehicleId])).rows,
    ).toEqual([{ branch_id: branchId }])
    expect(
      (await pool.query('select branch_id,status from expenses where id=$1', [expenseId])).rows,
    ).toEqual([{ branch_id: branchId, status: 'Approved' }])
  })

  it.each(['Pending', 'Paid', 'Received'] as const)(
    'handles %s payroll as an active obligation or retained history',
    async (status) => {
      const branchId = await branch(`payroll-${status}`)
      const records = await payroll(branchId, status)
      const result = await policy('branches', branchId)
      const blockingCount = status === 'Received' ? 0 : 1
      expect(result.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'payrollRuns', count: 1, blockingCount }),
          expect.objectContaining({ key: 'payrollEntries', count: 1, blockingCount }),
        ]),
      )
      expect(result.canArchive).toBe(status === 'Received')
      if (status === 'Received') {
        expect((await request('PATCH', `/branches/${branchId}/archive`, 'admin', {})).status).toBe(
          200,
        )
      } else {
        await expectBlocked('branches', branchId, ['payrollRuns', 'payrollEntries'])
      }
      expect(
        (
          await pool.query('select id,branch_id,payment_status from payroll_entries where id=$1', [
            records.entryId,
          ])
        ).rows,
      ).toEqual([{ id: records.entryId, branch_id: branchId, payment_status: status }])
      expect(
        (await pool.query('select id,branch_id from payroll_runs where id=$1', [records.runId]))
          .rows,
      ).toEqual([{ id: records.runId, branch_id: branchId }])
    },
  )

  it('blocks a Processed summary-only payroll run instead of treating absent receipts as complete', async () => {
    const branchId = await branch('legacy-payroll')
    await insertId(
      `insert into payroll_runs (reference,period_start,period_end,branch_id,status,employee_count,gross_pay)
       values ($1,'2020-10-01','2020-10-15',$2,'Processed',2,'200.00') returning id`,
      [`ARCH-LEGACY-${randomUUID()}`, branchId],
    )
    expect((await policy('branches', branchId)).canArchive).toBe(false)
    await expectBlocked('branches', branchId, ['payrollRuns'])
  })

  it('blocks unresolved returns on completed orders for both the branch and the product', async () => {
    const branchId = await branch('returns')
    const productId = await product('returns')
    const records = await completedOrder(branchId, productId)
    const returnId = await insertId(
      `insert into order_returns (reference,request_key,order_id,delivery_id,reason,status,requested_by)
       values ($1,$2,$3,$4,'Return awaiting receipt','Approved',$5) returning id`,
      [
        `ARCH-R-${randomUUID()}`,
        randomUUID(),
        records.orderId,
        records.deliveryId,
        accounts.admin!.id,
      ],
    )
    await pool.query(
      `insert into order_return_items (return_id,order_item_id,quantity,condition)
       values ($1,$2,1,'Resalable')`,
      [returnId, records.orderItemId],
    )
    for (const [module, id] of [
      ['branches', branchId],
      ['products', productId],
    ] as const) {
      const result = await policy(module, id)
      expect(result.dependencies.find(({ key }) => key === 'orders')).toMatchObject({
        count: 1,
        blockingCount: 0,
      })
      expect(result.dependencies.find(({ key }) => key === 'returns')).toMatchObject({
        count: 1,
        blockingCount: 1,
      })
      expect(result.canArchive).toBe(false)
      await expectBlocked(module, id, ['returns'])
    }
  })

  it('keeps unresolved stock transfers from archiving their product and retains completed transfer history', async () => {
    const fromBranchId = await branch('transfer-from')
    const toBranchId = await branch('transfer-to')
    const productId = await product('transfer')
    const transferId = await insertId(
      `insert into inventory_transfers (reference,from_branch_id,to_branch_id,status,requested_by)
       values ($1,$2,$3,'Pending',$4) returning id`,
      [`ARCH-T-${randomUUID()}`, fromBranchId, toBranchId, accounts.admin!.id],
    )
    const itemId = await insertId(
      'insert into inventory_transfer_items (transfer_id,product_id,quantity) values ($1,$2,1) returning id',
      [transferId, productId],
    )
    expect((await policy('products', productId)).canArchive).toBe(false)
    await expectBlocked('products', productId, ['transfers'])
    await pool.query("update inventory_transfers set status='Completed' where id=$1", [transferId])
    const historical = await policy('products', productId)
    expect(historical.canArchive).toBe(true)
    expect(historical.dependencies).toContainEqual({
      key: 'transfers',
      label: 'Stock transfers',
      count: 1,
      blockingCount: 0,
    })
    expect((await request('PATCH', `/products/${productId}/archive`, 'admin', {})).status).toBe(200)
    expect(
      (await pool.query('select id,status from inventory_transfers where id=$1', [transferId]))
        .rows,
    ).toEqual([{ id: transferId, status: 'Completed' }])
    expect(
      (
        await pool.query(
          'select id,product_id,quantity from inventory_transfer_items where id=$1',
          [itemId],
        )
      ).rows,
    ).toEqual([{ id: itemId, product_id: productId, quantity: '1.000' }])
  })

  it('soft archives a branch and product while preserving completed orders, deliveries, payments, movements, and audit', async () => {
    const branchId = await branch('history')
    const productId = await product('history')
    const records = await completedOrder(branchId, productId)
    await pool.query('insert into inventory (product_id,branch_id) values ($1,$2)', [
      productId,
      branchId,
    ])
    const paymentId = await insertId(
      `insert into payments (reference,order_id,method,amount,recorded_by,payment_date)
       values ($1,$2,'Cash','10.00',$3,'2020-10-16') returning id`,
      [`ARCH-RECEIPT-${randomUUID()}`, records.orderId, accounts.admin!.id],
    )
    const movementId = await insertId(
      `insert into inventory_transactions (product_id,branch_id,transaction_type,quantity_delta,reference_type,reference_id,performed_by)
       values ($1,$2,'Sale',-1,'Order',$3,$4) returning id`,
      [productId, branchId, records.orderId, accounts.admin!.id],
    )
    const auditId = await insertId(
      `insert into audit_logs (user_id,branch_id,action,entity_type,entity_id,new_value)
       values ($1,$2,'Historical material price','products',$3,'{"unitPrice":"10.00"}') returning id`,
      [accounts.admin!.id, branchId, productId],
    )
    const snapshot = async () => {
      const result = await pool.query<{ snapshot: Record<string, unknown> }>(
        `select jsonb_build_object(
          'order',(select to_jsonb(o) from orders o where o.id=$1),
          'line',(select to_jsonb(i) from order_items i where i.id=$2),
          'delivery',(select to_jsonb(d) from deliveries d where d.id=$3),
          'deliveryLine',(select to_jsonb(di) from delivery_items di where di.id=$4),
          'payment',(select to_jsonb(p) from payments p where p.id=$5),
          'movement',(select to_jsonb(m) from inventory_transactions m where m.id=$6),
          'audit',(select to_jsonb(a) from audit_logs a where a.id=$7),
          'inventory',(select to_jsonb(stock) from inventory stock where stock.product_id=$8 and stock.branch_id=$9)
        ) as snapshot`,
        [
          records.orderId,
          records.orderItemId,
          records.deliveryId,
          records.deliveryItemId,
          paymentId,
          movementId,
          auditId,
          productId,
          branchId,
        ],
      )
      return result.rows[0]!.snapshot
    }
    const before = await snapshot()
    for (const [module, id] of [
      ['products', productId],
      ['branches', branchId],
    ] as const) {
      const result = await policy(module, id)
      expect(result.canArchive).toBe(true)
      expect(result.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'orders', count: 1, blockingCount: 0 }),
          expect.objectContaining({ key: 'deliveries', count: 1, blockingCount: 0 }),
          expect.objectContaining({ key: 'payments', count: 1, blockingCount: 0 }),
          expect.objectContaining({ key: 'movements', count: 1, blockingCount: 0 }),
        ]),
      )
      expect((await request('PATCH', `/${module}/${id}/archive`, 'admin', {})).status).toBe(200)
      expect((await request('GET', `/${module}/${id}`)).status).toBe(404)
      const record = await pool.query<{ archived: boolean; deletedBy: string }>(
        `select deleted_at is not null as archived,deleted_by::text as "deletedBy" from ${module} where id=$1`,
        [id],
      )
      expect(record.rows).toEqual([{ archived: true, deletedBy: accounts.admin!.id }])
    }
    expect(await snapshot()).toEqual(before)
    const audit = await pool.query<{ action: string }>(
      'select action from audit_logs where entity_id=any($1::uuid[])',
      [[branchId, productId]],
    )
    expect(audit.rows.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        'archived branches',
        'archived products',
        'Historical material price',
      ]),
    )
  })
})
