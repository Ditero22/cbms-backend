import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { pool } from '@/database/client.js'
import {
  createPayrollRun,
  getPayrollRunDetail,
  updatePayrollRun,
} from '@/features/payroll/payroll.service.js'
import * as payrollReads from '@/features/payroll/payroll-read.repository.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

let user: AuthenticatedUser
let branchId: string
let employeeId: string

async function insertId(sql: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(sql, values)
  return result.rows[0]!.id
}

beforeAll(async () => {
  const suffix = randomUUID().slice(0, 8)
  branchId = await insertId('insert into branches (name,code) values($1,$2) returning id', [
    'Snapshot branch',
    suffix,
  ])
  const roleId = await insertId('insert into roles(name) values($1) returning id', [
    `Snapshot ${suffix}`,
  ])
  const id = await insertId(
    "insert into users(name,email,password_hash,role_id,branch_id,status) values('Snapshot actor',$1,'unused-test-hash',$2,$3,'Active') returning id",
    [`snapshot-${suffix}@example.invalid`, roleId, branchId],
  )
  employeeId = await insertId(
    "insert into employees(employee_number,name,position,branch_id) values($1,'Snapshot employee','Laborer',$2) returning id",
    [`SNAP-${suffix}`, branchId],
  )
  user = {
    id,
    name: 'Snapshot actor',
    email: `snapshot-${suffix}@example.invalid`,
    role: 'Manager',
    branchId,
    branch: 'Snapshot branch',
    isCrossBranch: false,
    permissions: ['payroll.read', 'payroll.create', 'payroll.update'],
  }
})

afterAll(async () => {
  await pool.end()
})

it('returns one payroll snapshot when a draft changes between header and entry reads', async () => {
  const context = { user, ipAddress: null, requestId: null }
  const input = {
    branchId,
    periodStart: '2026-10-01',
    periodEnd: '2026-10-15',
    entries: [
      {
        employeeId,
        payBasis: 'Daily wage' as const,
        units: '1',
        rate: '100.00',
        adjustments: [
          {
            kind: 'earning' as const,
            type: 'Bonus' as const,
            amount: '10.00',
            notes: 'Initial adjustment',
          },
        ],
      },
    ],
  }
  const run = await createPayrollRun(input, context)
  const readRun = payrollReads.readPayrollRun
  const intercepted = vi
    .spyOn(payrollReads, 'readPayrollRun')
    .mockImplementationOnce(async (...args) => {
      const header = await readRun(...args)
      await updatePayrollRun(
        run.id,
        { ...input, entries: [{ ...input.entries[0]!, rate: '200.00' }] },
        context,
      )
      return header
    })
  try {
    const duringUpdate = await getPayrollRunDetail(run.id, user)
    expect(duringUpdate.run.grossPay).toBe('110.00')
    expect(duringUpdate.entries).toMatchObject([
      { grossPay: '110.00', adjustments: [{ amount: '10.00' }] },
    ])
  } finally {
    intercepted.mockRestore()
  }
  const afterUpdate = await getPayrollRunDetail(run.id, user)
  expect(afterUpdate.run.grossPay).toBe('210.00')
  expect(afterUpdate.entries).toMatchObject([
    { grossPay: '210.00', adjustments: [{ amount: '10.00' }] },
  ])
  await expect(
    getPayrollRunDetail(run.id, { ...user, branchId: randomUUID() }),
  ).rejects.toMatchObject({ code: 'PAYROLL_RUN_NOT_FOUND' })
  await expect(getPayrollRunDetail(run.id, { ...user, permissions: [] })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  })
})
