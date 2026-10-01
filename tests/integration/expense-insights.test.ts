import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { pool } from '@/database/client.js'
import { createModuleRecord } from '@/features/records/record.service.js'
import { reviewExpense } from '@/features/expenses/expense.service.js'
import { generateReport } from '@/features/reports/reports.service.js'
import { getDashboardSummary } from '@/features/dashboard/dashboard.service.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

const prefix = `EXP-INS-${randomUUID().slice(0, 8)}`
let actor: AuthenticatedUser
let otherBranchId: string
async function insertId(sql: string, values: unknown[]) {
  return (await pool.query<{ id: string }>(sql, values)).rows[0]!.id
}
beforeAll(async () => {
  const roleId = await insertId('insert into roles(name) values($1) returning id', [prefix])
  const branchId = await insertId('insert into branches(name,code) values($1,$2) returning id', [
    `${prefix} North`,
    `${prefix}-N`,
  ])
  otherBranchId = await insertId('insert into branches(name,code) values($1,$2) returning id', [
    `${prefix} South`,
    `${prefix}-S`,
  ])
  const userId = await insertId(
    "insert into users(name,email,password_hash,role_id,branch_id) values('Expense analyst',$1,'unused',$2,$3) returning id",
    [`${prefix}@example.invalid`, roleId, branchId],
  )
  actor = {
    id: userId,
    name: 'Expense analyst',
    email: `${prefix}@example.invalid`,
    role: prefix,
    branchId,
    branch: `${prefix} North`,
    isCrossBranch: false,
    permissions: ['expenses.read', 'expenses.create', 'expenses.approve', 'reports.view'],
  }
  await pool.query(
    "insert into expenses(description,category,branch_id,submitted_by,amount,status,approved_by,approved_at) values($1,'Operations',$2,$3,9999,'Approved',$3,now())",
    [`${prefix} Foreign`, otherBranchId, userId],
  )
})
afterAll(() => pool.end())

it('keeps pending/rejected expenses out of approved totals and clears reviewed dashboard tasks', async () => {
  const context = { user: actor, ipAddress: null, requestId: null }
  const create = async (name: string, amount: string) => {
    const record = await createModuleRecord(
      'expenses',
      {
        description: `${prefix} ${name}`,
        category: 'Operations',
        amount,
      },
      context,
    )
    expect(record.id).toBeTruthy()
    return record.id!
  }
  const first = await create('Tools', '150.25')
  const second = await create('Consumables', '50.10')
  const third = await create('Rejected request', '12.34')
  const now = new Date()
  const date = (offset: number) =>
    new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10)
  const report = () =>
    generateReport({ report: 'approved-expenses', dateFrom: date(-1), dateTo: date(1) }, actor)
  expect((await report()).rows).toEqual([])
  const tasks = async () =>
    (await getDashboardSummary(actor)).priorityTasks.filter((task) => task.type === 'expense')
  expect((await tasks()).every((task) => !task.text.includes('Foreign'))).toBe(true)
  await reviewExpense(first, { decision: 'Approved', note: 'Confirmed cost' }, context)
  expect((await report()).rows).toEqual([
    {
      Branch: `${prefix} North`,
      Category: 'Operations',
      'Approved expenses': '1',
      'Total (PHP)': '150.25',
    },
  ])
  await reviewExpense(third, { decision: 'Rejected', note: 'Duplicate request' }, context)
  await reviewExpense(second, { decision: 'Approved' }, context)
  expect(await tasks()).toEqual([])
  expect((await report()).rows).toEqual([
    {
      Branch: `${prefix} North`,
      Category: 'Operations',
      'Approved expenses': '2',
      'Total (PHP)': '200.35',
    },
  ])
  await expect(
    reviewExpense(second, { decision: 'Rejected', note: 'Stale review' }, context),
  ).rejects.toMatchObject({ code: 'EXPENSE_ALREADY_REVIEWED' })
  expect((await report()).rows[0]?.['Total (PHP)']).toBe('200.35')
  expect((await getDashboardSummary({ ...actor, permissions: [] })).priorityTasks).toEqual([])
  await create('Large equipment request', '999999999999.99')
  expect((await tasks())[0]?.meta).toBe('₱999,999,999,999.99 · Expense analyst')
  expect((await report()).rows[0]?.['Total (PHP)']).toBe('200.35')
})
