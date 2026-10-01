import { withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import type { CreateEmployeeInput, UpdateEmployeeInput } from './employee.schemas.js'
import * as employeeRepository from './employee.repository.js'

type EmployeeRequestContext = {
  user: AuthenticatedUser
  ipAddress: string | null
  requestId: string | null
}

const employeeHistoryPageSize = 20

export async function getEmployeeDetail(
  employeeId: string,
  user: AuthenticatedUser,
  historyPage = 1,
) {
  requirePermission(user, 'employees.read')
  const employee = await employeeRepository.getEmployeeDetail(
    employeeId,
    getAssignedBranchScope(user),
  )
  if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found.')
  const history = user.permissions.includes('audit.read')
    ? await employeeRepository.getEmployeeHistory(
        employeeId,
        historyPage,
        employeeHistoryPageSize,
        getAssignedBranchScope(user),
      )
    : { items: [], total: 0 }
  return {
    employee,
    history: history.items,
    historyPage,
    historyPageSize: employeeHistoryPageSize,
    historyTotal: history.total,
  }
}

export async function getEmployeeOptions(user: AuthenticatedUser) {
  if (
    !user.permissions.includes('employees.create') &&
    !user.permissions.includes('employees.update')
  ) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to manage employees.')
  }
  return {
    branches: await employeeRepository.getActiveEmployeeBranches(getAssignedBranchScope(user)),
  }
}

export async function createEmployee(input: CreateEmployeeInput, context: EmployeeRequestContext) {
  requirePermission(context.user, 'employees.create')
  assertBranchAccess(context.user, input.branchId)

  try {
    return await withTransaction(async (client) => {
      if (!(await employeeRepository.isActiveEmployeeBranch(client, input.branchId))) {
        throw new AppError(400, 'INVALID_BRANCH', 'Choose an active branch.')
      }

      const employeeId = await employeeRepository.insertEmployee(client, {
        ...input,
        email: input.email || null,
        phone: input.phone || null,
        hiredAt: input.hiredAt ?? null,
      })
      if (!employeeId)
        throw new AppError(500, 'EMPLOYEE_CREATE_FAILED', 'The employee could not be saved.')

      await employeeRepository.insertEmployeeAudit(client, {
        userId: context.user.id,
        branchId: input.branchId,
        employeeId,
        action: 'created employee',
        newValue: {
          ...input,
          email: input.email || null,
          phone: input.phone || null,
        },
        ipAddress: context.ipAddress,
        requestId: context.requestId,
      })

      return { id: employeeId }
    })
  } catch (error) {
    if (hasConstraintCode(error, '23505')) {
      throw new AppError(409, 'DUPLICATE_EMPLOYEE', 'An employee with this ID already exists.')
    }
    throw error
  }
}

export async function updateEmployee(
  employeeId: string,
  input: UpdateEmployeeInput,
  context: EmployeeRequestContext,
) {
  requirePermission(context.user, 'employees.update')
  const branchScope = getAssignedBranchScope(context.user)
  if (input.branchId) assertBranchAccess(context.user, input.branchId)

  try {
    return await withTransaction(async (client) => {
      const current = await employeeRepository.lockEmployee(client, employeeId, branchScope)
      if (!current) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found.')
      if (
        input.status === 'Inactive' ||
        input.isDriver === false ||
        (input.branchId && input.branchId !== current.branchId)
      ) {
        const defaults = await client.query(
          `select id from vehicles where default_driver_id=$1 and deleted_at is null limit 1`,
          [employeeId],
        )
        if (defaults.rowCount)
          throw new AppError(
            409,
            'DEFAULT_DRIVER_IN_USE',
            'Clear or replace this worker’s default vehicle assignment first.',
          )
      }
      if (
        input.status === 'Inactive' ||
        input.isDriver === false ||
        input.driverAvailability === 'Unavailable' ||
        (input.branchId && input.branchId !== current.branchId)
      ) {
        const live = await client.query(
          `select id from vehicle_assignments where driver_id=$1 and status in ('Scheduled','Active')`,
          [employeeId],
        )
        if (live.rowCount)
          throw new AppError(
            409,
            'DRIVER_ASSIGNED',
            'Finish or cancel this worker’s assignment before changing availability, capability, status or branch.',
          )
      }

      if (
        (input.branchId || (input.status === 'Active' && current.status !== 'Active')) &&
        !(await employeeRepository.isActiveEmployeeBranch(
          client,
          input.branchId ?? current.branchId,
        ))
      ) {
        throw new AppError(400, 'INVALID_BRANCH', 'Choose an active branch.')
      }

      const normalizedInput = {
        ...input,
        email: input.email === '' ? null : input.email,
        phone: input.phone === '' ? null : input.phone,
      }
      await employeeRepository.updateEmployee(client, employeeId, normalizedInput)
      const next = { ...current, ...normalizedInput }
      await employeeRepository.insertEmployeeAudit(client, {
        userId: context.user.id,
        branchId: input.branchId ?? current.branchId,
        employeeId,
        action:
          input.status && input.status !== current.status
            ? 'updated employee status'
            : 'updated employee',
        oldValue: current,
        newValue: next,
        ipAddress: context.ipAddress,
        requestId: context.requestId,
      })

      return { id: employeeId, status: next.status }
    })
  } catch (error) {
    if (hasConstraintCode(error, '23505')) {
      throw new AppError(409, 'DUPLICATE_EMPLOYEE', 'An employee with this ID already exists.')
    }
    throw error
  }
}

export async function archiveEmployee(employeeId: string, context: EmployeeRequestContext) {
  requirePermission(context.user, 'employees.update')
  const branchScope = getAssignedBranchScope(context.user)

  return withTransaction(async (client) => {
    const current = await employeeRepository.lockEmployee(client, employeeId, branchScope)
    if (!current) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found.')
    const defaults = await client.query(
      `select id from vehicles where default_driver_id=$1 and deleted_at is null limit 1`,
      [employeeId],
    )
    if (defaults.rowCount)
      throw new AppError(
        409,
        'DEFAULT_DRIVER_IN_USE',
        'Clear or replace this worker’s default vehicle assignment before archiving.',
      )
    const live = await client.query(
      `select id from vehicle_assignments where driver_id=$1 and status in ('Scheduled','Active')`,
      [employeeId],
    )
    if (live.rowCount)
      throw new AppError(
        409,
        'DRIVER_ASSIGNED',
        'Finish or cancel the worker’s assignment before archiving.',
      )

    const archived = await employeeRepository.archiveEmployee(client, employeeId, context.user.id)
    if (!archived) {
      throw new AppError(409, 'EMPLOYEE_ARCHIVE_CONFLICT', 'The employee is no longer active.')
    }

    await employeeRepository.insertEmployeeAudit(client, {
      userId: context.user.id,
      branchId: current.branchId,
      employeeId,
      action: 'archived employee',
      oldValue: current,
      newValue: {
        ...current,
        deletedAt: archived.deletedAt,
        deletedBy: context.user.id,
      },
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })

    return { id: employeeId, archivedAt: archived.deletedAt }
  })
}

function requirePermission(user: AuthenticatedUser, permission: string) {
  if (!user.permissions.includes(permission)) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to manage employees.')
  }
}

function assertBranchAccess(user: AuthenticatedUser, branchId: string) {
  if (!user.isCrossBranch && user.branchId !== branchId) {
    throw new AppError(
      403,
      'BRANCH_FORBIDDEN',
      'You can only manage employees for your assigned branch.',
    )
  }
}

function hasConstraintCode(error: unknown, expectedCode: string) {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === expectedCode
  )
}
