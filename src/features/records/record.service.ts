import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { createSchemas, insertModels } from './record-schemas.js'
import { AppError } from '@/shared/errors/AppError.js'
import { withTransaction } from '@/database/transaction.js'
import { models } from './record-models.js'
import * as recordRepository from './record.repository.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import { getProjectedAliases, moduleListQuerySchema } from './record-list.schema.js'
import { isManagedModule, updateRecordSchemas } from './record-lifecycle.schemas.js'
import type { ManagedModuleId } from './record-lifecycle.schemas.js'
import { createExpense } from '@/features/expenses/expense.service.js'
import { archiveBlockerMessage, getRecordArchivePolicy } from './record-archive.repository.js'
import { assertManagementAdministrator } from '@/shared/security/management-access.js'

type RecordRequestContext = {
  user: AuthenticatedUser
  ipAddress: string | null
  requestId: string | null
}

export async function listModuleRecords(moduleId: string, user: AuthenticatedUser, input: unknown) {
  assertModuleManagementAccess(moduleId, user)
  const model = models[moduleId]
  if (!model) throw new AppError(404, 'MODULE_NOT_FOUND', 'This module is not available.')
  if (!user.permissions.includes(model.permission)) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view this module.')
  }

  const parsedQuery = moduleListQuerySchema.safeParse(input)
  if (!parsedQuery.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'The list query is invalid.',
      parsedQuery.error.flatten(),
    )
  }

  const projectedAliases = getProjectedAliases(model.query)
  if (parsedQuery.data.sort && !projectedAliases.has(parsedQuery.data.sort)) {
    throw new AppError(400, 'INVALID_SORT', 'Choose a supported sort field.')
  }
  if (parsedQuery.data.status && !projectedAliases.has('Status')) {
    throw new AppError(400, 'INVALID_FILTER', 'Status filtering is not available for this module.')
  }
  if (parsedQuery.data.branchId === 'unassigned' && !model.unassignedBranchFilter) {
    throw new AppError(400, 'INVALID_FILTER', 'Unassigned branch filtering is not available here.')
  }
  if (parsedQuery.data.branchId && (!model.branchFilter || !user.isCrossBranch)) {
    throw new AppError(403, 'BRANCH_FORBIDDEN', 'You cannot filter records across branches.')
  }

  const assignedBranchId = model.branchFilter ? getAssignedBranchScope(user) : undefined
  const branchId = parsedQuery.data.branchId ?? assignedBranchId
  return recordRepository.getModuleRows(model, branchId, parsedQuery.data)
}

export async function createModuleRecord(
  moduleId: string,
  input: unknown,
  context: RecordRequestContext,
) {
  assertModuleManagementAccess(moduleId, context.user)
  if (moduleId === 'expenses') return createExpense(input, context)
  const schema = createSchemas[moduleId]
  const insertModel = insertModels[moduleId]
  if (!schema || !insertModel) {
    throw new AppError(
      404,
      'CREATE_NOT_SUPPORTED',
      'Creating records in this module is not available yet.',
    )
  }

  const permission = `${moduleId}.create`
  if (!context.user.permissions.includes(permission)) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to create records here.')
  }

  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the entered values.', parsed.error.flatten())
  }

  const entries = Object.entries(parsed.data).filter(
    ([key, value]) =>
      value !== undefined && value !== '' && !(moduleId === 'customers' && key === 'branchId'),
  )
  let branchId = context.user.branchId
  if (moduleId === 'customers') {
    const requestedBranchId = context.user.isCrossBranch
      ? ((parsed.data.branchId as string | null | undefined) ?? null)
      : getAssignedBranchScope(context.user)
    branchId = requestedBranchId ?? null
    entries.push(['branchId', branchId])
  }
  const columns = entries
    .map(([key]) => insertModel.columns[key])
    .filter((column): column is string => Boolean(column))
  const values = entries.map(([, value]) => value)

  try {
    const id = await withTransaction(async (client) => {
      if (
        moduleId === 'customers' &&
        branchId &&
        !(await recordRepository.isActiveBranch(client, branchId))
      ) {
        throw new AppError(400, 'INVALID_BRANCH', 'Choose an active branch for this customer.')
      }
      if (
        moduleId === 'products' &&
        parsed.data.supplierId &&
        !(await recordRepository.isActiveSupplier(client, parsed.data.supplierId as string))
      ) {
        throw new AppError(400, 'INVALID_SUPPLIER', 'Choose an active supplier.')
      }
      const entityId = await recordRepository.insertModuleRecord(
        client,
        insertModel.table,
        columns,
        values,
      )

      if (moduleId === 'products' && entityId) {
        await recordRepository.initializeProductInventory(client, entityId)
      }
      if (moduleId === 'branches' && entityId) {
        await recordRepository.initializeBranchInventory(client, entityId)
      }
      if (entityId) {
        await recordRepository.insertCreatedRecordAudit(client, {
          userId: context.user.id,
          branchId: moduleId === 'branches' ? entityId : branchId,
          moduleId,
          entityId,
          record: moduleId === 'customers' ? { ...parsed.data, branchId } : parsed.data,
          ipAddress: context.ipAddress,
          requestId: context.requestId,
        })
      }

      return entityId
    })

    return { id }
  } catch (error) {
    if (hasConstraintCode(error, '23505')) {
      throw new AppError(
        409,
        'DUPLICATE_RECORD',
        'A record with one of these unique values already exists.',
      )
    }
    if (hasConstraintCode(error, '23503')) {
      throw new AppError(400, 'INVALID_REFERENCE', 'Choose a valid related record.')
    }
    throw error
  }
}

export async function getProductOptions(user: AuthenticatedUser) {
  if (
    !user.permissions.includes('products.create') &&
    !user.permissions.includes('products.update')
  ) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to manage products.')
  }
  return { suppliers: await recordRepository.getActiveSupplierOptions() }
}

export async function getCustomerCreateOptions(user: AuthenticatedUser) {
  if (!user.permissions.includes('customers.create')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to create customers.')
  }
  if (!user.isCrossBranch) return { branches: [] }
  return { branches: await recordRepository.getActiveBranchOptions() }
}

export async function getModuleRecord(moduleId: string, recordId: string, user: AuthenticatedUser) {
  assertModuleManagementAccess(moduleId, user)
  const managedModule = requireManagedModule(moduleId)
  requireRecordPermission(user, `${managedModule}.read`)
  const branchScope = managedModule === 'customers' ? getAssignedBranchScope(user) : undefined
  const record = await recordRepository.getManagedRecord(managedModule, recordId, branchScope)
  if (!record) throw new AppError(404, 'RECORD_NOT_FOUND', 'Record not found.')

  const relatedBranchScope = user.isCrossBranch ? null : (user.branchId ?? 'none')
  const [related, history, supplierName, archivePolicy] = await Promise.all([
    recordRepository.getManagedRecordRelated(
      managedModule,
      recordId,
      user.permissions,
      relatedBranchScope,
    ),
    user.permissions.includes('audit.read')
      ? recordRepository.getManagedRecordHistory(managedModule, recordId, relatedBranchScope)
      : Promise.resolve([]),
    managedModule === 'products' && record.supplierId
      ? recordRepository.getProductSupplierName(record.supplierId as string)
      : Promise.resolve(null),
    user.permissions.includes(`${managedModule}.update`)
      ? recordRepository.getManagedRecordArchivePolicy(managedModule, recordId)
      : undefined,
  ])
  return {
    ...record,
    ...(managedModule === 'products' ? { supplierName } : {}),
    related,
    history,
    ...(archivePolicy ? { archivePolicy } : {}),
  }
}

export async function updateModuleRecord(
  moduleId: string,
  recordId: string,
  input: unknown,
  context: RecordRequestContext,
) {
  assertModuleManagementAccess(moduleId, context.user)
  const managedModule = requireManagedModule(moduleId)
  requireRecordPermission(context.user, `${managedModule}.update`)
  const parsed = updateRecordSchemas[managedModule].safeParse(input)
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the entered values.', parsed.error.flatten())
  }

  const normalizedInput = Object.fromEntries(
    Object.entries(parsed.data).map(([key, value]) => [key, value === '' ? null : value]),
  )
  const branchScope =
    managedModule === 'customers' ? getAssignedBranchScope(context.user) : undefined

  try {
    return await withTransaction(async (client) => {
      const current = await recordRepository.lockManagedRecord(
        client,
        managedModule,
        recordId,
        branchScope,
      )
      if (!current) throw new AppError(404, 'RECORD_NOT_FOUND', 'Record not found.')
      if (
        managedModule === 'customers' &&
        normalizedInput.status === 'Active' &&
        current.status !== 'Active' &&
        current.branchId &&
        !(await recordRepository.isActiveBranch(client, current.branchId as string))
      ) {
        throw new AppError(
          400,
          'INVALID_BRANCH',
          'Activate this customer’s branch before reactivating the customer.',
        )
      }
      if (
        managedModule === 'branches' &&
        normalizedInput.status === 'Inactive' &&
        current.status !== 'Inactive'
      ) {
        const policy = await getRecordArchivePolicy(client, managedModule, recordId)
        if (!policy.canArchive) {
          throw new AppError(409, 'RECORD_IN_USE', archiveBlockerMessage(policy), {
            dependencies: policy.dependencies.filter((dependency) => dependency.blockingCount > 0),
          })
        }
      }
      if (
        managedModule === 'products' &&
        normalizedInput.supplierId &&
        !(await recordRepository.isActiveSupplier(client, normalizedInput.supplierId as string))
      ) {
        throw new AppError(400, 'INVALID_SUPPLIER', 'Choose an active supplier.')
      }
      await recordRepository.updateManagedRecord(client, managedModule, recordId, normalizedInput)
      if (normalizedInput.status === 'Active' && current.status !== 'Active') {
        if (managedModule === 'branches')
          await recordRepository.initializeBranchInventory(client, recordId)
        if (managedModule === 'products')
          await recordRepository.initializeProductInventory(client, recordId)
      }
      const updated = await recordRepository.lockManagedRecord(
        client,
        managedModule,
        recordId,
        branchScope,
      )
      if (!updated) throw new Error('The updated record could not be loaded.')
      await recordRepository.insertManagedRecordAudit(client, {
        userId: context.user.id,
        branchId:
          managedModule === 'branches'
            ? recordId
            : managedModule === 'customers'
              ? (current.branchId as string)
              : context.user.branchId,
        moduleId: managedModule,
        entityId: recordId,
        action:
          normalizedInput.status && normalizedInput.status !== current.status
            ? `updated ${managedModule} status`
            : `updated ${managedModule}`,
        oldValue: current,
        newValue: updated,
        ipAddress: context.ipAddress,
        requestId: context.requestId,
      })
      return { ...updated, related: {}, history: [] }
    })
  } catch (error) {
    if (hasConstraintCode(error, '23505')) {
      throw new AppError(409, 'DUPLICATE_RECORD', 'A record with that unique value already exists.')
    }
    if (hasConstraintCode(error, '23503')) {
      throw new AppError(400, 'INVALID_REFERENCE', 'Choose a valid related record.')
    }
    throw error
  }
}

export async function archiveModuleRecord(
  moduleId: string,
  recordId: string,
  context: RecordRequestContext,
) {
  assertModuleManagementAccess(moduleId, context.user)
  const managedModule = requireManagedModule(moduleId)
  requireRecordPermission(context.user, `${managedModule}.update`)
  const branchScope =
    managedModule === 'customers' ? getAssignedBranchScope(context.user) : undefined

  return withTransaction(async (client) => {
    const current = await recordRepository.lockManagedRecord(
      client,
      managedModule,
      recordId,
      branchScope,
    )
    if (!current) throw new AppError(404, 'RECORD_NOT_FOUND', 'Record not found.')
    if (managedModule === 'branches' || managedModule === 'products') {
      const policy = await getRecordArchivePolicy(client, managedModule, recordId)
      if (!policy.canArchive) {
        throw new AppError(409, 'RECORD_IN_USE', archiveBlockerMessage(policy), {
          dependencies: policy.dependencies.filter((dependency) => dependency.blockingCount > 0),
        })
      }
    } else if (await recordRepository.hasBlockingReferences(client, managedModule, recordId)) {
      throw new AppError(
        409,
        'RECORD_IN_USE',
        'This record still has active assignments, stock, or open work. Resolve those before archiving.',
      )
    }
    const archived = await recordRepository.archiveManagedRecord(
      client,
      managedModule,
      recordId,
      context.user.id,
      branchScope,
    )
    if (!archived) throw new AppError(409, 'ARCHIVE_CONFLICT', 'This record is already archived.')
    await recordRepository.insertManagedRecordAudit(client, {
      userId: context.user.id,
      branchId:
        managedModule === 'branches'
          ? recordId
          : managedModule === 'customers'
            ? (current.branchId as string)
            : context.user.branchId,
      moduleId: managedModule,
      entityId: recordId,
      action: `archived ${managedModule}`,
      oldValue: current,
      newValue: { ...current, archivedAt: archived.archivedAt, archivedBy: context.user.id },
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })
    return { id: recordId, archivedAt: archived.archivedAt }
  })
}

function requireManagedModule(moduleId: string): ManagedModuleId {
  if (!isManagedModule(moduleId)) {
    throw new AppError(404, 'MODULE_NOT_FOUND', 'This record workflow is not available.')
  }
  return moduleId
}

function assertModuleManagementAccess(moduleId: string, user: AuthenticatedUser) {
  if (moduleId === 'branches' || moduleId === 'users') assertManagementAdministrator(user)
}

function requireRecordPermission(user: AuthenticatedUser, permission: string) {
  if (!user.permissions.includes(permission)) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to manage this record.')
  }
}

function hasConstraintCode(error: unknown, expectedCode: string): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === expectedCode
  )
}
