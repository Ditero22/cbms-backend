import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { pool } from '@/database/client.js'
import { permissionKeys } from '@/database/permissions.js'
import { generateReport } from '@/features/reports/reports.service.js'
import { reportQuerySchema } from '@/features/reports/reports.schemas.js'
import { getReportOptions } from '@/features/reports/report-options.repository.js'
import { getDashboardSummary } from '@/features/dashboard/dashboard.service.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

const suffix = randomUUID().slice(0, 8)
let actor: AuthenticatedUser,
  branchId: string,
  otherBranchId: string,
  driverId: string,
  defaultDriverId: string,
  vehicleId: string,
  customerId: string,
  orderId: string
const dates = { dateFrom: '2020-01-01', dateTo: '2020-12-31' }
const id = async (sql: string, args: unknown[]) =>
  (await pool.query<{ id: string }>(sql, args)).rows[0]!.id
beforeAll(async () => {
  const roleId = await id('insert into roles(name) values($1) returning id', [
    `Fleet reporter ${suffix}`,
  ])
  branchId = await id('insert into branches(name,code) values($1,$2) returning id', [
    `Report North ${suffix}`,
    `rn-${suffix}`,
  ])
  otherBranchId = await id('insert into branches(name,code) values($1,$2) returning id', [
    `Report South ${suffix}`,
    `rs-${suffix}`,
  ])
  const userId = await id(
    "insert into users(name,email,password_hash,role_id,branch_id) values('Reporter',$1,'unused-test',$2,$3) returning id",
    [`reporter-${suffix}@example.invalid`, roleId, branchId],
  )
  actor = {
    id: userId,
    name: 'Reporter',
    email: `reporter-${suffix}@example.invalid`,
    role: 'Reporter',
    branchId,
    branch: 'North',
    isCrossBranch: true,
    permissions: permissionKeys,
  }
  driverId = await id(
    "insert into employees(employee_number,name,position,branch_id,is_driver) values($1,'Actual trip driver','Truck Driver',$2,1) returning id",
    [`RD-${suffix}`, branchId],
  )
  defaultDriverId = await id(
    "insert into employees(employee_number,name,position,branch_id,is_driver) values($1,'Default regular driver','Truck Driver',$2,1) returning id",
    [`RF-${suffix}`, branchId],
  )
  vehicleId = await id(
    "insert into vehicles(name,plate_number,vehicle_type,capacity_value,capacity_unit,default_driver_id,status,branch_id) values($1,$2,'Water Truck',5000,'L',$3,'On Service',$4) returning id",
    [`Reporting truck ${suffix}`, `RP-${suffix}`, defaultDriverId, branchId],
  )
  customerId = await id('insert into customers(name,branch_id) values($1,$2) returning id', [
    `Reporting customer ${suffix}`,
    branchId,
  ])
  const productId = await id(
    "insert into products(name,sku,category,unit,unit_price) values('Reporting material',$1,'Materials','piece',10) returning id",
    [`RP-${suffix}`],
  )
  orderId = await id(
    'insert into orders(order_number,customer_id,branch_id,total_amount,created_by) values($1,$2,$3,100,$4) returning id',
    [`RPT-${suffix}`, customerId, branchId, userId],
  )
  await pool.query(
    'insert into order_items(order_id,product_id,quantity,unit_price,line_total) values($1,$2,10,10,100)',
    [orderId, productId],
  )
  const deliveryId = await id(
    "insert into deliveries(reference,order_id,destination,status) values($1,$2,'Reporting site','In Transit') returning id",
    [`RPD-${suffix}`, orderId],
  )
  await pool.query(
    "insert into vehicle_assignments(reference,vehicle_id,driver_id,branch_id,delivery_id,destination,purpose,scheduled_at,started_at,status,created_by) values($1,$2,$3,$4,$5,'Reporting site','Delivery','2019-12-31','2020-01-02','Active',$6)",
    [`RPA-${suffix}`, vehicleId, driverId, branchId, deliveryId, userId],
  )
  await pool.query(
    "insert into driver_allowances(reference,worker_id,branch_id,delivery_id,payment_type,amount,payment_timing,method,created_by,created_at) values($1,$2,$3,$4,'Trip allowance',1500.25,'After trip','Cash',$5,'2020-01-02')",
    [`RAL-${suffix}`, driverId, branchId, deliveryId, userId],
  )
  await pool.query(
    "insert into driver_allowances(reference,worker_id,branch_id,payment_type,amount,payment_timing,method,created_by,created_at) values($1,$2,$3,'Trip allowance',900,'Immediate','Cash',$4,'2020-01-02')",
    [`RAL-other-${suffix}`, driverId, otherBranchId, userId],
  )
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())
  await pool.query(
    "insert into vehicle_maintenance(reference,vehicle_id,branch_id,maintenance_type,description,labor_cost,parts_cost,other_cost,status,started_on,completed_on,created_by) values($1,$2,$3,'Oil Change','Recorded repair',100.10,200.20,50.05,'Completed',$4,$4,$5)",
    [`RPM-${suffix}`, vehicleId, branchId, today, userId],
  )
  await pool.query(
    "insert into payments(reference,order_id,method,amount,recorded_by,payment_date) values($1,$2,'GCash',30.25,$3,'2020-02-01')",
    [`RPP-${suffix}`, orderId, userId],
  )
})
afterAll(() => pool.end())

it('reports current actual driver, capacity, trip dates, and delivery-linked allowance vehicle filters', async () => {
  const fleet = await generateReport(
    { report: 'fleet-status', ...dates, vehicleId, driverId },
    actor,
  )
  expect(fleet.rows).toHaveLength(1)
  expect(fleet.rows[0]).toMatchObject({
    Driver: 'Actual trip driver',
    Status: 'On Service',
    Capacity: '5000.000 L',
  })
  const branchFleet = await generateReport(
    { report: 'fleet-status', ...dates, branchId: otherBranchId },
    { ...actor, isCrossBranch: false },
  )
  expect(branchFleet.rows).toHaveLength(1)
  expect(branchFleet.rows[0]?.Vehicle).toBe(`Reporting truck ${suffix}`)
  const selectedAdminBranch = await generateReport(
    { report: 'fleet-status', ...dates, branchId: otherBranchId },
    actor,
  )
  expect(selectedAdminBranch.rows).toHaveLength(0)
  const trips = await generateReport(
    { report: 'fleet-assignments', ...dates, vehicleId, driverId, customerId, status: 'Active' },
    actor,
  )
  expect(trips.rows).toHaveLength(1)
  expect(trips.rows[0]?.Customer).toBe(`Reporting customer ${suffix}`)
  const allowances = await generateReport(
    { report: 'driver-allowances', ...dates, vehicleId, driverId, customerId },
    { ...actor, isCrossBranch: false },
  )
  expect(allowances.rows).toHaveLength(1)
  expect(allowances.rows[0]).toMatchObject({
    'Amount (PHP)': '1500.25',
    Status: 'Pending',
    'Proof files': '0',
  })
})
it('reports scoped customer balances and immutable receipts independently of the selected receipt date', async () => {
  const snapshot = await generateReport(
    { report: 'customer-balances', ...dates, customerId },
    actor,
  )
  expect(snapshot.rows).toHaveLength(1)
  expect(snapshot.rows[0]).toMatchObject({
    'Total (PHP)': '100.00',
    'Net paid (PHP)': '30.25',
    'Balance (PHP)': '69.75',
    Status: 'Partially Paid',
  })
  const history = await generateReport(
    { report: 'customer-payment-history', ...dates, customerId },
    actor,
  )
  expect(history.rows).toHaveLength(1)
  expect(history.rows[0]).toMatchObject({
    'Payment date': '2020-02-01',
    Method: 'GCash',
    'Amount (PHP)': '30.25',
  })
  const other = await generateReport(
    { report: 'customer-balances', ...dates, customerId },
    { ...actor, isCrossBranch: false, branchId: otherBranchId },
  )
  expect(other.rows).toHaveLength(0)
})
it('keeps exact monthly repairs, pending allowances, and outstanding collections permission gated', async () => {
  const scoped = { ...actor, isCrossBranch: false }
  const summary = await getDashboardSummary(scoped)
  expect(summary.operations).toMatchObject({
    fleet: { available: 0, onService: 1, underMaintenance: 0, unavailable: 0 },
    maintenanceMonthlyCost: '350.35',
    pendingAllowances: { count: 1, amount: '1500.25', awaitingReceipt: 0 },
    customerBalances: { outstandingBalance: '69.75', outstandingOrders: 1 },
  })
  const denied = await getDashboardSummary({ ...scoped, permissions: [] })
  expect(denied.operations).toEqual({
    fleet: null,
    maintenanceMonthlyCost: null,
    pendingAllowances: null,
    customerBalances: null,
  })
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())
  const costs = await generateReport(
    { report: 'fleet-maintenance', dateFrom: today, dateTo: today, vehicleId },
    scoped,
  )
  expect(costs.rows[0]).toMatchObject({ 'Total (PHP)': '350.35', Status: 'Completed' })
})
it('rejects missing financial grants, unsupported report filters, and logs actual export filters', async () => {
  await expect(
    generateReport(
      { report: 'driver-allowances', ...dates },
      { ...actor, permissions: ['reports.view'] },
    ),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(
    generateReport(
      { report: 'fleet-maintenance', ...dates },
      { ...actor, permissions: ['reports.view', 'vehicles.maintenance'] },
    ),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(
    reportQuerySchema.safeParse({ report: 'inventory-health', ...dates, driverId }).success,
  ).toBe(false)
  expect(
    reportQuerySchema.safeParse({ report: 'driver-allowances', ...dates, status: 'Paid' }).success,
  ).toBe(false)
  await generateReport({ report: 'fleet-assignments', ...dates, vehicleId, driverId }, actor, true)
  const audit = (
    await pool.query<{ newValue: { filters: { vehicleId: string; driverId: string } } }>(
      'select new_value as "newValue" from audit_logs where user_id=$1 and action=\'exported report\' order by created_at desc limit 1',
      [actor.id],
    )
  ).rows[0]
  expect(audit?.newValue.filters).toMatchObject({ vehicleId, driverId })
})
it('keeps historical report driver choices after capability removal and a branch move', async () => {
  await pool.query('update employees set is_driver=0,branch_id=$2 where id=$1', [
    driverId,
    otherBranchId,
  ])
  const options = await getReportOptions({ ...actor, isCrossBranch: false })
  expect(options.drivers.some((driver) => driver.id === driverId)).toBe(false)
  expect(options.vehicles.some((vehicle) => vehicle.id === vehicleId)).toBe(true)
  const forgedBranchOptions = await getReportOptions(
    { ...actor, isCrossBranch: false },
    otherBranchId,
  )
  expect(forgedBranchOptions.vehicles.some((vehicle) => vehicle.id === vehicleId)).toBe(true)
  const adminBranchOptions = await getReportOptions(actor, otherBranchId)
  expect(adminBranchOptions.vehicles.some((vehicle) => vehicle.id === vehicleId)).toBe(false)
})
