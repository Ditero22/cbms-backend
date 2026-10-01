import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { pool } from '@/database/client.js'
import { listModuleRecords } from '@/features/records/record.service.js'
import { getDashboardSummary } from '@/features/dashboard/dashboard.service.js'
import { generateReport } from '@/features/reports/reports.service.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

let actor: AuthenticatedUser
let branchId: string
let otherBranchId: string
let atPointId: string
const prefix = `INS-${randomUUID().slice(0, 8)}`
async function id(sql: string, values: unknown[]) {
  return (await pool.query<{ id: string }>(sql, values)).rows[0]!.id
}
beforeAll(async () => {
  const roleId = await id('insert into roles(name) values($1) returning id', [prefix])
  branchId = await id('insert into branches(name,code) values($1,$2) returning id', [
    `${prefix} North`,
    `${prefix}-N`,
  ])
  otherBranchId = await id('insert into branches(name,code) values($1,$2) returning id', [
    `${prefix} South`,
    `${prefix}-S`,
  ])
  const userId = await id(
    "insert into users(name,email,password_hash,role_id,branch_id) values('Stock analyst',$1,'unused',$2,$3) returning id",
    [`${prefix}@example.invalid`, roleId, branchId],
  )
  actor = {
    id: userId,
    name: 'Stock analyst',
    email: `${prefix}@example.invalid`,
    role: prefix,
    branchId,
    branch: `${prefix} North`,
    isCrossBranch: false,
    permissions: ['inventory.read', 'reports.view'],
  }
  const stocks = [
    ['empty', '0', '0'],
    ['below', '9.500', '0'],
    ['at point', '10.000', '0'],
    ['reserved', '11.000', '10.000'],
  ]
  for (const [name, quantity, reserved] of stocks) {
    const productId = await id(
      "insert into products(name,sku,category,unit,unit_price) values($1,$2,'Materials','kg',1) returning id",
      [`${prefix} ${name}`, `${prefix}-${name}`],
    )
    const stockId = await id(
      'insert into inventory(product_id,branch_id,quantity,reserved_quantity,reorder_level) values($1,$2,$3,$4,10) returning id',
      [productId, branchId, quantity, reserved],
    )
    if (name === 'at point') atPointId = stockId
    await pool.query(
      'insert into inventory(product_id,branch_id,quantity,reorder_level) values($1,$2,0,10)',
      [productId, otherBranchId],
    )
  }
})
afterAll(() => pool.end())

it('uses the same inclusive on-hand reorder threshold in Inventory, dashboard and reports', async () => {
  const list = await listModuleRecords('inventory', actor, {
    search: prefix,
    status: 'Low stock',
    sort: 'On hand',
    order: 'asc',
  })
  expect(list.total).toBe(2)
  expect(list.data.map((row) => row.Product)).toEqual([`${prefix} below`, `${prefix} at point`])
  expect(list.data[1]?.id).toBe(atPointId)
  const summary = await getDashboardSummary(actor)
  expect(summary.stats.stockAlerts).toBe(3)
  const report = await generateReport(
    { report: 'inventory-health', dateFrom: '2026-10-01', dateTo: '2026-10-01' },
    actor,
  )
  expect(report.rows).toEqual([
    { Branch: `${prefix} North`, 'Tracked products': '4', 'Low stock': '2', 'Out of stock': '1' },
  ])
  await pool.query('update inventory set reorder_level=9.999 where id=$1', [atPointId])
  expect(
    (await listModuleRecords('inventory', actor, { search: prefix, status: 'Low stock' })).total,
  ).toBe(1)
  expect((await getDashboardSummary(actor)).stats.stockAlerts).toBe(2)
  expect(
    (
      await generateReport(
        { report: 'inventory-health', dateFrom: '2026-10-01', dateTo: '2026-10-01' },
        actor,
      )
    ).rows[0]?.['Low stock'],
  ).toBe('1')
})

it('keeps reservations separate from physical quantity and fails closed without a branch', async () => {
  const list = await listModuleRecords('inventory', actor, { search: `${prefix} reserved` })
  expect(list.data).toHaveLength(1)
  expect(list.data[0]).toMatchObject({
    'On hand': '11.000 kg',
    Reserved: '10.000 kg',
    Available: '1.000 kg',
    Status: 'In stock',
  })
  expect((await getDashboardSummary({ ...actor, permissions: [] })).stats.stockAlerts).toBe(0)
  await expect(
    listModuleRecords('inventory', { ...actor, branchId: null }, {}),
  ).rejects.toMatchObject({ code: 'BRANCH_REQUIRED' })
  await expect(
    generateReport(
      { report: 'inventory-health', dateFrom: '2026-10-01', dateTo: '2026-10-01' },
      { ...actor, branchId: null },
    ),
  ).rejects.toMatchObject({ code: 'BRANCH_REQUIRED' })
})
