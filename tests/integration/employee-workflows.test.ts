import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '@/app.js'
import { pool } from '@/database/client.js'
import {
  archiveEmployee,
  createEmployee,
  getEmployeeDetail,
  updateEmployee,
} from '@/features/employees/employee.service.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import {
  createSessionToken,
  hashSessionToken,
  sessionCookieName,
} from '@/shared/security/session.js'

let server: Server
let apiUrl: string
let actorCookie: string
let primaryBranchId: string
let otherBranchId: string
let actor: AuthenticatedUser
let employeeNumber: string

async function insertId(query: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(query, values)
  const id = result.rows[0]?.id
  if (!id) throw new Error('An employee integration fixture could not be created.')
  return id
}

beforeAll(async () => {
  const fixture = randomUUID().slice(0, 8)
  employeeNumber = `EMP-${fixture}`
  const roleId = await insertId('insert into roles (name) values ($1) returning id', [
    `Employee test role ${fixture}`,
  ])
  for (const permission of ['employees.read', 'employees.create', 'employees.update']) {
    await pool.query(
      'insert into permissions(key,description) values($1,$2) on conflict do nothing',
      [permission, `Employee HTTP ${permission}`],
    )
    await pool.query('insert into role_permissions(role_id,permission_key) values($1,$2)', [
      roleId,
      permission,
    ])
  }
  primaryBranchId = await insertId(
    'insert into branches (name, code) values ($1, $2) returning id',
    ['Employee test North', `en-${fixture}`],
  )
  otherBranchId = await insertId('insert into branches (name, code) values ($1, $2) returning id', [
    'Employee test South',
    `es-${fixture}`,
  ])
  const actorId = await insertId(
    `insert into users (email, name, password_hash, role_id, branch_id, status)
     values ($1, $2, 'unused-test-hash', $3, $4, 'Active') returning id`,
    [`employee-test-${fixture}@example.invalid`, 'Employee test actor', roleId, primaryBranchId],
  )
  actor = {
    id: actorId,
    name: 'Employee test actor',
    email: `employee-test-${fixture}@example.invalid`,
    role: `Employee test role ${fixture}`,
    branchId: primaryBranchId,
    branch: 'Employee test North',
    isCrossBranch: false,
    permissions: ['employees.read', 'employees.create', 'employees.update', 'audit.read'],
  }
  const token = createSessionToken()
  await pool.query(
    `insert into user_sessions(user_id,token_hash,expires_at)
     values($1,$2,now()+interval '1 hour')`,
    [actorId, hashSessionToken(token)],
  )
  actorCookie = `${sessionCookieName}=${token}`
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('The employee test server did not start.')
  apiUrl = `http://127.0.0.1:${address.port}/api/v1`
})

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  await pool.end()
})

describe('employee persistence, access, and history', () => {
  it('creates, reads, edits, and archives a real employee with audit history', async () => {
    const context = { user: actor, ipAddress: null, requestId: null }
    const created = await createEmployee(
      {
        employeeNumber,
        name: 'Juan Dela Cruz',
        position: 'Site Engineer',
        branchId: primaryBranchId,
        email: 'juan@example.invalid',
        phone: '+63 900 000 0000',
        hiredAt: '2026-09-01',
        address: 'Test-only worker address',
        emergencyContactName: 'Test contact',
        emergencyContactPhone: '555-0140',
      },
      context,
    )
    const initial = await getEmployeeDetail(created.id, actor)
    expect(initial.employee).toMatchObject({
      employeeNumber,
      name: 'Juan Dela Cruz',
      branchName: 'Employee test North',
      hiredAt: '2026-09-01',
      status: 'Active',
      address: 'Test-only worker address',
      emergencyContactName: 'Test contact',
    })
    expect(initial.history).toMatchObject([
      { action: 'created employee', actorName: 'Employee test actor' },
    ])
    expect(initial.historyTotal).toBe(1)

    await updateEmployee(
      created.id,
      { position: 'Project Engineer', status: 'Inactive', hiredAt: null, address: null },
      context,
    )
    const updated = await getEmployeeDetail(created.id, actor)
    expect(updated.employee).toMatchObject({
      position: 'Project Engineer',
      status: 'Inactive',
      hiredAt: null,
      address: null,
    })
    expect(updated.historyTotal).toBe(2)
    expect(updated.history[0]).toMatchObject({
      action: 'updated employee status',
      actorName: 'Employee test actor',
      oldValue: { position: 'Site Engineer', status: 'Active', hiredAt: '2026-09-01' },
      newValue: { position: 'Project Engineer', status: 'Inactive', hiredAt: null },
    })
    const beyondLastPage = await getEmployeeDetail(created.id, actor, 2)
    expect(beyondLastPage.history).toEqual([])
    expect(beyondLastPage.historyTotal).toBe(2)

    await archiveEmployee(created.id, context)
    const archived = await getEmployeeDetail(created.id, actor)
    expect(archived.employee.archivedAt).not.toBeNull()
    expect(archived.historyTotal).toBe(3)
    expect(archived.history.map((entry) => entry.action).sort()).toEqual([
      'archived employee',
      'created employee',
      'updated employee status',
    ])
    await expect(updateEmployee(created.id, { status: 'Active' }, context)).rejects.toMatchObject({
      code: 'EMPLOYEE_NOT_FOUND',
    })
  })

  it('enforces read and write permissions and current branch scope', async () => {
    const context = { user: actor, ipAddress: null, requestId: null }
    const created = await createEmployee(
      {
        employeeNumber: `${employeeNumber}-2`,
        name: 'Maria Santos',
        position: 'Estimator',
        branchId: primaryBranchId,
      },
      context,
    )
    const noRead = { ...actor, permissions: ['employees.create', 'employees.update'] }
    await expect(getEmployeeDetail(created.id, noRead)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    const otherBranchReader = { ...actor, branchId: otherBranchId, branch: 'Employee test South' }
    await expect(getEmployeeDetail(created.id, otherBranchReader)).rejects.toMatchObject({
      code: 'EMPLOYEE_NOT_FOUND',
    })
    await expect(
      updateEmployee(created.id, { branchId: otherBranchId }, context),
    ).rejects.toMatchObject({ code: 'BRANCH_FORBIDDEN' })
    await expect(
      updateEmployee(
        created.id,
        { status: 'Inactive' },
        {
          ...context,
          user: { ...actor, permissions: ['employees.read'] },
        },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      archiveEmployee(created.id, {
        ...context,
        user: { ...actor, branchId: otherBranchId },
      }),
    ).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })

    const crossBranch = { ...actor, isCrossBranch: true }
    await updateEmployee(created.id, { branchId: otherBranchId }, { ...context, user: crossBranch })
    await expect(getEmployeeDetail(created.id, actor)).rejects.toMatchObject({
      code: 'EMPLOYEE_NOT_FOUND',
    })
    const moved = await getEmployeeDetail(created.id, otherBranchReader)
    expect(moved.employee.branchId).toBe(otherBranchId)
    expect(moved.historyTotal).toBe(1)
  })

  it('enforces assigned-branch scope through authenticated employee HTTP routes', async () => {
    const suffix = randomUUID().slice(0, 8)
    const own = await fetch(`${apiUrl}/employees`, {
      method: 'POST',
      headers: { Cookie: actorCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employeeNumber: `HTTP-${suffix}-A`,
        name: `Scope-${suffix} employee A`,
        position: 'Foreman',
        branchId: primaryBranchId,
      }),
    })
    expect(own.status).toBe(201)
    const ownEmployee = (await own.json()) as { id: string }
    const foreignEmployeeId = await insertId(
      `insert into employees(employee_number,name,position,branch_id)
       values($1,$2,'Foreman',$3) returning id`,
      [`HTTP-${suffix}-B`, `Scope-${suffix} employee B`, otherBranchId],
    )

    const get = (path: string) => fetch(`${apiUrl}${path}`, { headers: { Cookie: actorCookie } })
    const options = await get('/employees/options')
    expect(options.status).toBe(200)
    expect(await options.json()).toMatchObject({ branches: [{ id: primaryBranchId }] })

    const list = await get(`/employees?search=${encodeURIComponent(`Scope-${suffix}`)}`)
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { data: { id: string }[] }
    expect(listed.data.map((employee) => employee.id)).toEqual([ownEmployee.id])
    expect((await get(`/employees?branchId=${otherBranchId}`)).status).toBe(403)
    expect((await get(`/employees/${foreignEmployeeId}`)).status).toBe(404)

    const foreignEdit = await fetch(`${apiUrl}/employees/${foreignEmployeeId}`, {
      method: 'PATCH',
      headers: { Cookie: actorCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'Senior foreman' }),
    })
    expect(foreignEdit.status).toBe(404)
    const foreignArchive = await fetch(`${apiUrl}/employees/${foreignEmployeeId}/archive`, {
      method: 'PATCH',
      headers: { Cookie: actorCookie, 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(foreignArchive.status).toBe(404)

    const forgedCreate = await fetch(`${apiUrl}/employees`, {
      method: 'POST',
      headers: { Cookie: actorCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employeeNumber: `HTTP-${suffix}-C`,
        name: `Forged employee ${suffix}`,
        position: 'Foreman',
        branchId: otherBranchId,
      }),
    })
    expect(forgedCreate.status).toBe(403)
    expect(await forgedCreate.json()).toMatchObject({ error: { code: 'BRANCH_FORBIDDEN' } })
  })

  it('returns user-facing errors for duplicate identifiers and inactive/unknown branches', async () => {
    const context = { user: actor, ipAddress: null, requestId: null }
    const base = {
      employeeNumber: `${employeeNumber}-3`,
      name: 'Pedro Reyes',
      position: 'Foreman',
      branchId: primaryBranchId,
    }
    await createEmployee(base, context)
    await expect(createEmployee(base, context)).rejects.toMatchObject({
      code: 'DUPLICATE_EMPLOYEE',
    })
    await expect(
      createEmployee(
        { ...base, employeeNumber: `${employeeNumber}-4`, branchId: randomUUID() },
        { ...context, user: { ...actor, isCrossBranch: true } },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_BRANCH' })
    await pool.query("update branches set status = 'Inactive' where id = $1", [otherBranchId])
    await expect(
      createEmployee(
        { ...base, employeeNumber: `${employeeNumber}-5`, branchId: otherBranchId },
        { ...context, user: { ...actor, isCrossBranch: true } },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_BRANCH' })
  })
})
