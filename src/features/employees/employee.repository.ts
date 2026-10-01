import type { PoolClient } from 'pg'
import { pool } from '@/database/client.js'

const driverSelection = `(is_driver=1) as "isDriver", license_number as "licenseNumber", license_classification as "licenseClassification", license_expires_on as "licenseExpiresOn", driver_availability as "driverAvailability", emergency_contact_name as "emergencyContactName", emergency_contact_phone as "emergencyContactPhone", notes`

export async function getActiveEmployeeBranches(branchId: string | null | undefined) {
  const result = await pool.query<{ id: string; name: string }>(
    `select id, name
     from branches
     where deleted_at is null and status = 'Active'
       and ($1::uuid is null or id = $1)
     order by name`,
    [branchId ?? null],
  )
  return result.rows
}

export async function isActiveEmployeeBranch(client: PoolClient, branchId: string) {
  const result = await client.query<{ id: string }>(
    "select id from branches where id = $1 and deleted_at is null and status = 'Active' for share",
    [branchId],
  )
  return result.rowCount === 1
}

export async function getEmployeeDetail(employeeId: string, branchId: string | null | undefined) {
  const result = await pool.query<{
    id: string
    employeeNumber: string
    name: string
    position: string
    branchId: string
    branchName: string
    email: string | null
    phone: string | null
    address: string | null
    status: string
    hiredAt: string | null
    createdAt: Date
    updatedAt: Date
    archivedAt: Date | null
  }>(
    `select e.id, e.employee_number as "employeeNumber", e.name, e.position, ${driverSelection},
            e.branch_id as "branchId", b.name as "branchName", e.email, e.phone, e.address,
            e.status, to_char(e.hired_at at time zone 'UTC', 'YYYY-MM-DD') as "hiredAt",
            e.created_at as "createdAt", e.updated_at as "updatedAt",
            e.deleted_at as "archivedAt"
     from employees e
     join branches b on b.id = e.branch_id
     where e.id = $1
       and ($2::uuid is null or e.branch_id = $2)`,
    [employeeId, branchId ?? null],
  )
  return result.rows[0]
}

export async function getEmployeeHistory(
  employeeId: string,
  page: number,
  pageSize: number,
  branchId?: string | null,
) {
  const countResult = await pool.query<{ total: number }>(
    `select count(*)::int as total
     from audit_logs where entity_type = 'employees' and entity_id = $1 and ($2::uuid is null or branch_id=$2)`,
    [employeeId, branchId ?? null],
  )
  const total = countResult.rows[0]?.total ?? 0
  if (total === 0) return { items: [], total }

  const result = await pool.query<{
    id: string
    action: string
    actorName: string
    oldValue: Record<string, unknown> | null
    newValue: Record<string, unknown> | null
    createdAt: Date
  }>(
    `select a.id, a.action, coalesce(u.name, 'Former user') as "actorName",
            a.old_value as "oldValue", a.new_value as "newValue",
            a.created_at as "createdAt"
     from audit_logs a
     left join users u on u.id = a.user_id
     where a.entity_type = 'employees' and a.entity_id = $1
       and ($4::uuid is null or a.branch_id=$4)
     order by a.created_at desc, a.id desc
     limit $2 offset $3`,
    [employeeId, pageSize, (page - 1) * pageSize, branchId ?? null],
  )
  return { items: result.rows, total }
}

export async function insertEmployee(
  client: PoolClient,
  employee: {
    employeeNumber: string
    name: string
    position: string
    branchId: string
    email: string | null
    phone: string | null
    hiredAt: string | null
    isDriver?: boolean | undefined
    address?: string | null | undefined
    licenseNumber?: string | null | undefined
    licenseClassification?: string | null | undefined
    licenseExpiresOn?: string | null | undefined
    driverAvailability?: string | undefined
    emergencyContactName?: string | null | undefined
    emergencyContactPhone?: string | null | undefined
    notes?: string | null | undefined
  },
) {
  const result = await client.query<{ id: string }>(
    `insert into employees (employee_number, name, position, branch_id, email, phone, hired_at)
     values ($1, $2, $3, $4, $5, $6, $7::date::timestamp at time zone 'UTC')
     returning id`,
    [
      employee.employeeNumber,
      employee.name,
      employee.position,
      employee.branchId,
      employee.email,
      employee.phone,
      employee.hiredAt,
    ],
  )
  if (result.rows[0])
    await updateEmployee(
      client,
      result.rows[0].id,
      Object.fromEntries(
        Object.entries(employee).filter(([key]) =>
          [
            'address',
            'isDriver',
            'licenseNumber',
            'licenseClassification',
            'licenseExpiresOn',
            'driverAvailability',
            'emergencyContactName',
            'emergencyContactPhone',
            'notes',
          ].includes(key),
        ),
      ),
    )
  return result.rows[0]?.id
}

export async function lockEmployee(
  client: PoolClient,
  employeeId: string,
  branchId: string | null | undefined,
) {
  const result = await client.query<{
    id: string
    branchId: string
    employeeNumber: string
    name: string
    position: string
    email: string | null
    phone: string | null
    status: string
    hiredAt: string | null
  }>(
    `select id, branch_id as "branchId", employee_number as "employeeNumber", ${driverSelection},
        name, position, email, phone, address, status,
        to_char(hired_at at time zone 'UTC', 'YYYY-MM-DD') as "hiredAt"
     from employees
     where id = $1 and deleted_at is null
       and ($2::uuid is null or branch_id = $2)
     for update`,
    [employeeId, branchId ?? null],
  )
  return result.rows[0]
}

export async function updateEmployee(
  client: PoolClient,
  employeeId: string,
  fields: Record<string, unknown>,
) {
  const columnByField: Record<string, string> = {
    employeeNumber: 'employee_number',
    name: 'name',
    position: 'position',
    branchId: 'branch_id',
    email: 'email',
    phone: 'phone',
    address: 'address',
    status: 'status',
    hiredAt: 'hired_at',
    isDriver: 'is_driver',
    licenseNumber: 'license_number',
    licenseClassification: 'license_classification',
    licenseExpiresOn: 'license_expires_on',
    driverAvailability: 'driver_availability',
    emergencyContactName: 'emergency_contact_name',
    emergencyContactPhone: 'emergency_contact_phone',
    notes: 'notes',
  }
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined)
  const assignments = entries.map(([field], index) =>
    field === 'hiredAt'
      ? `hired_at = $${index + 1}::date::timestamp at time zone 'UTC'`
      : `${columnByField[field]} = $${index + 1}`,
  )
  assignments.push('updated_at = now()')
  const values = entries.map(([field, value]) => (field === 'isDriver' ? (value ? 1 : 0) : value))
  values.push(employeeId)

  await client.query(
    `update employees set ${assignments.join(', ')} where id = $${values.length}`,
    values,
  )
}

export async function archiveEmployee(client: PoolClient, employeeId: string, archivedBy: string) {
  const result = await client.query<{ deletedAt: string }>(
    `update employees
     set deleted_at = now(), deleted_by = $2, updated_at = now()
     where id = $1 and deleted_at is null
     returning deleted_at::text as "deletedAt"`,
    [employeeId, archivedBy],
  )
  return result.rows[0]
}

export async function insertEmployeeAudit(
  client: PoolClient,
  values: {
    userId: string
    branchId: string
    employeeId: string
    action: string
    oldValue?: Record<string, unknown>
    newValue: Record<string, unknown>
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    `insert into audit_logs
      (user_id, branch_id, action, entity_type, entity_id, old_value, new_value, ip_address, request_id)
     values ($1, $2, $3, 'employees', $4, $5, $6, $7, $8)`,
    [
      values.userId,
      values.branchId,
      values.action,
      values.employeeId,
      values.oldValue ?? null,
      values.newValue,
      values.ipAddress,
      values.requestId,
    ],
  )
}
