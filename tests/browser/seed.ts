import { permissionKeys } from '@/database/permissions.js'
import { hashPassword } from '@/shared/security/password.js'
import { assertIntegrationTestEnvironment } from '../../scripts/local-test-database.mjs'

process.env.DATABASE_URL = assertIntegrationTestEnvironment().href
const databaseName = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1)
if (!/^cbms_integration_browser_[a-f0-9]+$/.test(databaseName)) {
  throw new Error('Browser fixtures may only be written to the disposable browser-test database.')
}
const password = process.env.CBMS_E2E_PASSWORD
if (!password) throw new Error('The browser-test runner must provide a temporary password.')
// Load the pool only after validating and pinning its effective local destination.
const { pool } = await import('@/database/client.js')

async function insertId(sql: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(sql, values)
  const id = result.rows[0]?.id
  if (!id) throw new Error('Could not create a browser fixture.')
  return id
}

try {
  const branchId = await insertId(
    'insert into branches (name, code) values ($1, $2) returning id',
    ['Acceptance branch', 'QA-NORTH'],
  )
  const customerId = await insertId(
    'insert into customers (name, branch_id) values ($1, $2) returning id',
    ['Acceptance customer', branchId],
  )
  const productId = await insertId(
    `insert into products (name, sku, category, unit, unit_price)
     values ($1, $2, 'Materials', 'piece', '10.00') returning id`,
    ['Acceptance material', 'QA-MATERIAL'],
  )
  await pool.query('insert into inventory (product_id, branch_id, quantity) values ($1, $2, 200)', [
    productId,
    branchId,
  ])
  const passwordHash = await hashPassword(password)
  const roleIds: Record<string, string> = {}
  for (const permission of permissionKeys) {
    await pool.query(
      'insert into permissions (key, description) values ($1, $2) on conflict (key) do nothing',
      [permission, `Acceptance permission: ${permission}`],
    )
  }
  for (const [name, permissions, crossBranch] of [
    ['Acceptance administrator', permissionKeys, 1],
    ['Acceptance viewer', ['sales.read', 'orders.read', 'payments.read', 'deliveries.read'], 0],
  ] as const) {
    const roleId = await insertId(
      'insert into roles (name, is_system) values ($1, $2) returning id',
      [name, crossBranch ? 1 : 0],
    )
    roleIds[name] = roleId
    for (const permission of permissions) {
      await pool.query('insert into role_permissions (role_id, permission_key) values ($1, $2)', [
        roleId,
        permission,
      ])
    }
    await pool.query(
      `insert into users (email, name, password_hash, role_id, branch_id, is_cross_branch, status)
       values ($1, $2, $3, $4, $5, $6, 'Active')`,
      [
        crossBranch ? 'administrator@example.invalid' : 'viewer@example.invalid',
        name,
        passwordHash,
        roleId,
        branchId,
        crossBranch,
      ],
    )
  }
  const masterReaderRoleId = await insertId(
    'insert into roles (name, is_system) values ($1, 1) returning id',
    ['Acceptance master-data reader'],
  )
  for (const permission of [
    'branches.read',
    'employees.read',
    'customers.read',
    'suppliers.read',
    'products.read',
  ]) {
    await pool.query('insert into role_permissions (role_id, permission_key) values ($1, $2)', [
      masterReaderRoleId,
      permission,
    ])
  }
  await pool.query(
    `insert into users (email, name, password_hash, role_id, branch_id, is_cross_branch, status)
     values ($1, $2, $3, $4, $5, 1, 'Active')`,
    [
      'master-reader@example.invalid',
      'Acceptance master-data reader',
      passwordHash,
      masterReaderRoleId,
      branchId,
    ],
  )
  const otherBranchId = await insertId(
    'insert into branches (name, code) values ($1, $2) returning id',
    ['Acceptance other branch', 'QA-SOUTH'],
  )
  const accountFixtures: Record<string, string> = {}
  for (const fixture of [
    {
      key: 'accountReader',
      name: 'Acceptance account reader',
      email: 'account-reader@example.invalid',
      permissions: ['users.read', 'roles.read'],
      branch: branchId,
    },
    {
      key: 'branchManager',
      name: 'Acceptance branch manager',
      email: 'branch-manager@example.invalid',
      permissions: [
        'employees.read',
        'payroll.read',
        'payroll.create',
        'payroll.update',
        'payroll.process',
        'payroll.pay',
        'payroll.receive',
      ],
      branch: branchId,
    },
    {
      key: 'otherBranch',
      name: 'Acceptance other branch account',
      email: 'other-branch@example.invalid',
      permissions: ['users.read', 'roles.read'],
      branch: otherBranchId,
    },
  ]) {
    const roleId = await insertId('insert into roles (name) values ($1) returning id', [
      fixture.name,
    ])
    for (const permission of fixture.permissions) {
      await pool.query('insert into role_permissions (role_id, permission_key) values ($1, $2)', [
        roleId,
        permission,
      ])
    }
    const userId = await insertId(
      `insert into users (email, name, password_hash, role_id, branch_id, is_cross_branch, status)
       values ($1, $2, $3, $4, $5, 0, 'Active') returning id`,
      [fixture.email, fixture.name, passwordHash, roleId, fixture.branch],
    )
    accountFixtures[`${fixture.key}RoleId`] = roleId
    accountFixtures[`${fixture.key}UserId`] = userId
  }
  for (let index = 1; index <= 7; index += 1) {
    await pool.query(
      `insert into users (email, name, password_hash, role_id, branch_id, is_cross_branch, status)
       values ($1, $2, $3, $4, $5, 0, 'Active')`,
      [
        `pagination-${index}@example.invalid`,
        `Acceptance pagination account ${index}`,
        passwordHash,
        accountFixtures.accountReaderRoleId,
        branchId,
      ],
    )
  }
  const actor = await pool.query<{ id: string }>(
    "select id from users where email = 'administrator@example.invalid'",
  )
  const actorId = actor.rows[0]!.id
  const legacyDriverId = await insertId(
    `insert into employees(employee_number,name,position,branch_id,is_driver)
     values('QA-LEGACY-DRIVER','Acceptance legacy driver','Driver',$1,1) returning id`,
    [branchId],
  )
  const legacyAllowancePendingId = await insertId(
    `insert into driver_allowances(reference,worker_id,branch_id,payment_type,amount,payment_timing,method,status,created_by)
     values('QA-ALLOWANCE-PENDING',$1,$2,'Trip allowance','1500.00','After trip','Cash','Pending',$3) returning id`,
    [legacyDriverId, branchId, actorId],
  )
  const legacyAllowanceReceivedId = await insertId(
    `insert into driver_allowances(reference,worker_id,branch_id,payment_type,amount,payment_timing,method,status,created_by,authorized_by,authorized_at,released_by,released_at,confirmed_by,received_at,acknowledgement)
     values('QA-ALLOWANCE-RECEIVED',$1,$2,'Trip allowance','1500.00','After trip','Cash','Received',$3,$3,now()-interval '3 days',$3,now()-interval '2 days',$3,now()-interval '1 day','Historical receipt confirmed') returning id`,
    [legacyDriverId, branchId, actorId],
  )
  const legacyAllowanceExpenseId = await insertId(
    `insert into expenses(branch_id,description,category,amount,submitted_by,status,approved_by,approved_at)
     values($1,'Driver allowance QA-ALLOWANCE-EXPENSE','Driver allowances','0.10',$2,'Approved',$2,now()-interval '1 day') returning id`,
    [branchId, actorId],
  )
  const legacyAllowanceReleasedId = await insertId(
    `insert into driver_allowances(reference,worker_id,branch_id,payment_type,amount,payment_timing,method,status,created_by,authorized_by,authorized_at,released_by,released_at,expense_id)
     values('QA-ALLOWANCE-EXPENSE',$1,$2,'Trip allowance','0.10','Immediate','Cash','Released',$3,$3,now()-interval '2 days',$3,now()-interval '1 day',$4) returning id`,
    [legacyDriverId, branchId, actorId, legacyAllowanceExpenseId],
  )
  const payrollLedgerRunId = await insertId(
    `insert into payroll_runs(reference,period_start,period_end,branch_id,status,employee_count,gross_pay,processed_by,processed_at)
     values('QA-PAYROLL-LEDGER','2026-08-01','2026-08-15',$1,'Processed',12,'1320.00',$2,now()-interval '1 day') returning id`,
    [branchId, actorId],
  )
  let payrollLedgerFirstEntryId = ''
  for (let index = 1; index <= 12; index += 1) {
    const number = `LEDGER-${String(index).padStart(2, '0')}`
    const name = `Ledger employee ${String(index).padStart(2, '0')}`
    const employeeId = await insertId(
      `insert into employees(employee_number,name,position,branch_id) values($1,$2,'Construction worker',$3) returning id`,
      [number, name, branchId],
    )
    const entryId = await insertId(
      `insert into payroll_entries(payroll_run_id,employee_id,branch_id,employee_number,employee_name,position,pay_basis,units,rate,regular_pay,additional_pay,deductions,gross_pay,net_pay)
       values($1,$2,$3,$4,$5,'Construction worker','Salary','1','100.00','100.00','10.00','5.00','110.00','105.00') returning id`,
      [payrollLedgerRunId, employeeId, branchId, number, name],
    )
    if (index === 1) payrollLedgerFirstEntryId = entryId
    await pool.query(
      `insert into payroll_entry_adjustments(payroll_entry_id,kind,type,amount,notes) values($1,'earning','Allowance','10.00','Recorded employee allowance'),($1,'deduction','Deduction','5.00','Recorded deduction')`,
      [entryId],
    )
  }
  const payrollOtherRunId = await insertId(
    `insert into payroll_runs(reference,period_start,period_end,branch_id,status,employee_count,gross_pay,processed_by,processed_at)
     values('QA-PAYROLL-OTHER','2026-08-01','2026-08-15',$1,'Processed',1,'100.00',$2,now()-interval '1 day') returning id`,
    [otherBranchId, actorId],
  )
  const payrollOtherEmployeeId = await insertId(
    `insert into employees(employee_number,name,position,branch_id) values('OTHER-LEDGER-01','Other payroll worker','Construction worker',$1) returning id`,
    [otherBranchId],
  )
  const payrollOtherEntryId = await insertId(
    `insert into payroll_entries(payroll_run_id,employee_id,branch_id,employee_number,employee_name,position,pay_basis,units,rate,regular_pay,gross_pay,net_pay)
     values($1,$2,$3,'OTHER-LEDGER-01','Other payroll worker','Construction worker','Salary','1','100.00','100.00','100.00','100.00') returning id`,
    [payrollOtherRunId, payrollOtherEmployeeId, otherBranchId],
  )
  const legacyProductId = await insertId(
    `insert into products (name, sku, category, unit, unit_price)
     values ($1, $2, 'Materials', 'piece', '10.00') returning id`,
    ['Acceptance legacy material', 'QA-LEGACY'],
  )
  await pool.query('insert into inventory (product_id, branch_id, quantity) values ($1, $2, 3)', [
    legacyProductId,
    branchId,
  ])
  const legacyOrderId = await insertId(
    `insert into orders (order_number, customer_id, branch_id, total_amount, status, stock_mode, created_by)
     values ('QA-LEGACY-001', $1, $2, '20.00', 'Delivered', 'LegacyConsumed', $3) returning id`,
    [customerId, branchId, actor.rows[0]!.id],
  )
  const legacyOrderItemId = await insertId(
    `insert into order_items (order_id, product_id, quantity, unit_price, line_total)
     values ($1, $2, '2.000', '10.00', '20.00') returning id`,
    [legacyOrderId, legacyProductId],
  )
  const legacyDeliveryId = await insertId(
    `insert into deliveries (reference, order_id, destination, status, allocation_origin, allocation_status)
     values ('QA-LEGACY-DELIVERY', $1, 'Historical construction site', 'Delivered', 'LegacyBackfill', 'Unverified') returning id`,
    [legacyOrderId],
  )
  await pool.query(
    `insert into delivery_items (delivery_id, order_item_id, quantity, inferred_quantity)
     values ($1, $2, '2.000', '2.000')`,
    [legacyDeliveryId, legacyOrderItemId],
  )
  console.log(
    JSON.stringify({
      branchId,
      customerId,
      productId,
      legacyOrderId,
      legacyDeliveryId,
      otherBranchId,
      legacyDriverId,
      legacyAllowancePendingId,
      legacyAllowanceReceivedId,
      legacyAllowanceReleasedId,
      legacyAllowanceExpenseId,
      payrollLedgerRunId,
      payrollLedgerFirstEntryId,
      payrollOtherEntryId,
      administratorRoleId: roleIds['Acceptance administrator'],
      ...accountFixtures,
    }),
  )
} finally {
  await pool.end()
}
