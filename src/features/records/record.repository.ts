import type { PoolClient } from 'pg'
import { pool } from '@/database/client.js'
import { addBranchFilter } from './query-scope.js'
import type { ModuleModel } from './record-models.js'
import type { ModuleListQuery } from './record-list.schema.js'
import { buildListFilters } from './record-list.query.js'
import { insertModels } from './record-schemas.js'
import type { ManagedModuleId } from './record-lifecycle.schemas.js'
import { getRecordArchivePolicy } from './record-archive.repository.js'

export async function getModuleRows(
  model: ModuleModel,
  branchId: string | null | undefined,
  listQuery: ModuleListQuery,
) {
  const unassignedFilter = branchId === 'unassigned' ? model.unassignedBranchFilter : undefined
  const isBranchScoped = Boolean(branchId && !unassignedFilter && model.branchFilter)
  const scopeFilter = unassignedFilter ?? (isBranchScoped ? model.branchFilter : undefined)
  const baseQuery = model.query.replace(/\s+order\s+by\s+[\s\S]*$/i, '')
  const scopedQuery = scopeFilter ? addBranchFilter(baseQuery, scopeFilter) : baseQuery
  const originallyOrderedQuery = scopeFilter
    ? addBranchFilter(model.query, scopeFilter)
    : model.query
  const branchParameters = isBranchScoped ? [branchId] : []
  const searchFilters = buildListFilters(
    listQuery,
    branchParameters.length,
    false,
    model.searchFields,
  )
  const resultFilters = buildListFilters(
    listQuery,
    branchParameters.length,
    true,
    model.searchFields,
  )
  const rowCount = await pool.query<{ total: string }>(
    `select count(*)::text as total from (${scopedQuery}) as module_rows${resultFilters.sql}`,
    [...branchParameters, ...resultFilters.parameters],
  )

  const sortSql = listQuery.sort
    ? ` order by ${model.sortExpressions?.[listQuery.sort] ?? `"${listQuery.sort.replaceAll('"', '""')}"`} ${listQuery.order} nulls last`
    : ''
  const limitParameter = branchParameters.length + resultFilters.parameters.length + 1
  const offsetParameter = limitParameter + 1
  const offset = (listQuery.page - 1) * listQuery.limit
  const rowsQuery = listQuery.sort ? scopedQuery : originallyOrderedQuery
  const rows = await pool.query(
    `select * from (${rowsQuery}) as module_rows${resultFilters.sql}${sortSql} limit $${limitParameter} offset $${offsetParameter}`,
    [...branchParameters, ...resultFilters.parameters, listQuery.limit, offset],
  )

  let statusOptions: string[] = []
  if (/\bas\s+"Status"/i.test(model.query)) {
    const statusFilters = searchFilters.sql
      ? `${searchFilters.sql} and module_rows."Status" is not null`
      : ' where module_rows."Status" is not null'
    const statuses = await pool.query<{ status: string }>(
      `select distinct module_rows."Status" as status from (${scopedQuery}) as module_rows${statusFilters} order by module_rows."Status" asc`,
      [...branchParameters, ...searchFilters.parameters],
    )
    statusOptions = statuses.rows.map(({ status }) => status)
  }

  return {
    data: rows.rows,
    total: Number(rowCount.rows[0]?.total ?? 0),
    page: listQuery.page,
    limit: listQuery.limit,
    statusOptions,
  }
}

export async function insertModuleRecord(
  client: PoolClient,
  table: string,
  columns: string[],
  values: unknown[],
) {
  const placeholders = values.map((_, index) => `$${index + 1}`)
  const result = await client.query<{ id: string }>(
    `insert into ${table} (${columns.join(', ')}) values (${placeholders.join(', ')}) returning id`,
    values,
  )
  return result.rows[0]?.id
}

export async function initializeProductInventory(client: PoolClient, productId: string) {
  await client.query(
    "insert into inventory (product_id, branch_id) select $1, id from branches where deleted_at is null and status = 'Active' on conflict do nothing",
    [productId],
  )
}

export async function initializeBranchInventory(client: PoolClient, branchId: string) {
  await client.query(
    'insert into inventory (product_id, branch_id) select id, $1 from products where deleted_at is null and status = $2 on conflict do nothing',
    [branchId, 'Active'],
  )
}

export async function insertCreatedRecordAudit(
  client: PoolClient,
  values: {
    userId: string
    branchId: string | null
    moduleId: string
    entityId: string
    record: Record<string, unknown>
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    'insert into audit_logs (user_id, branch_id, action, entity_type, entity_id, new_value, ip_address, request_id) values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [
      values.userId,
      values.branchId,
      `created ${values.moduleId}`,
      values.moduleId,
      values.entityId,
      values.record,
      values.ipAddress,
      values.requestId,
    ],
  )
}

function managedModel(moduleId: ManagedModuleId) {
  const model = insertModels[moduleId]!
  const fields = Object.entries(model.columns)
    .map(([field, column]) => `${column} as "${field}"`)
    .join(', ')
  return {
    table: model.table,
    columns: model.columns,
    selection: `id::text as "id", ${fields}, status as "status", created_at as "createdAt", updated_at as "updatedAt"`,
  }
}

export async function getManagedRecord(
  moduleId: ManagedModuleId,
  id: string,
  branchScope?: string,
) {
  const model = managedModel(moduleId)
  const extraSelection =
    moduleId === 'customers'
      ? ', (select name from branches where id = customers.branch_id) as "branchName"'
      : ''
  const branchCondition = moduleId === 'customers' && branchScope ? ' and branch_id = $2' : ''
  const result = await pool.query<Record<string, unknown>>(
    `select ${model.selection}${extraSelection} from ${model.table} where id = $1 and deleted_at is null${branchCondition}`,
    branchCondition ? [id, branchScope] : [id],
  )
  return result.rows[0]
}

export function getManagedRecordArchivePolicy(moduleId: ManagedModuleId, id: string) {
  return moduleId === 'branches' || moduleId === 'products'
    ? getRecordArchivePolicy(pool, moduleId, id)
    : undefined
}

export async function lockManagedRecord(
  client: PoolClient,
  moduleId: ManagedModuleId,
  id: string,
  branchScope?: string,
) {
  const model = managedModel(moduleId)
  const branchCondition =
    moduleId === 'branches' && branchScope
      ? ' and id = $2'
      : moduleId === 'customers' && branchScope
        ? ' and branch_id = $2'
        : ''
  const result = await client.query<Record<string, unknown>>(
    `select ${model.selection} from ${model.table} where id = $1 and deleted_at is null${branchCondition} for update`,
    branchCondition ? [id, branchScope] : [id],
  )
  return result.rows[0]
}

export async function updateManagedRecord(
  client: PoolClient,
  moduleId: ManagedModuleId,
  id: string,
  fields: Record<string, unknown>,
) {
  const model = managedModel(moduleId)
  const columns: Record<string, string> = { ...model.columns, status: 'status' }
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined)
  const assignments = entries.map(([field], index) => `${columns[field]} = $${index + 1}`)
  const values = entries.map(([, value]) => value)
  values.push(id)
  await client.query(
    `update ${model.table} set ${assignments.join(', ')}, updated_at = now() where id = $${values.length}`,
    values,
  )
}

export async function archiveManagedRecord(
  client: PoolClient,
  moduleId: ManagedModuleId,
  id: string,
  archivedBy: string,
  branchScope?: string,
) {
  const model = managedModel(moduleId)
  const branchCondition = moduleId === 'customers' && branchScope ? ' and branch_id = $3' : ''
  const result = await client.query<{ archivedAt: Date }>(
    `update ${model.table} set deleted_at = now(), deleted_by = $2, updated_at = now() where id = $1 and deleted_at is null${branchCondition} returning deleted_at as "archivedAt"`,
    branchCondition ? [id, archivedBy, branchScope] : [id, archivedBy],
  )
  return result.rows[0]
}

export async function isActiveSupplier(client: PoolClient, supplierId: string) {
  const result = await client.query<{ id: string }>(
    "select id from suppliers where id = $1 and deleted_at is null and status = 'Active' for share",
    [supplierId],
  )
  return result.rowCount === 1
}

export async function isActiveBranch(client: PoolClient, branchId: string) {
  const result = await client.query<{ id: string }>(
    "select id from branches where id = $1 and deleted_at is null and status = 'Active' for share",
    [branchId],
  )
  return result.rowCount === 1
}

export async function getActiveSupplierOptions() {
  const result = await pool.query<{ id: string; name: string }>(
    "select id::text as id, name from suppliers where deleted_at is null and status = 'Active' order by name",
  )
  return result.rows
}

export async function getActiveBranchOptions() {
  const result = await pool.query<{ id: string; name: string }>(
    "select id::text as id, name from branches where deleted_at is null and status = 'Active' order by name, id",
  )
  return result.rows
}

export async function getProductSupplierName(supplierId: string) {
  const result = await pool.query<{ name: string }>('select name from suppliers where id = $1', [
    supplierId,
  ])
  return result.rows[0]?.name ?? null
}

export async function hasBlockingReferences(
  client: PoolClient,
  moduleId: ManagedModuleId,
  id: string,
) {
  if (moduleId === 'branches') {
    return !(await getRecordArchivePolicy(client, moduleId, id)).canArchive
  }
  if (moduleId === 'products') {
    return !(await getRecordArchivePolicy(client, moduleId, id)).canArchive
  }
  if (moduleId === 'customers') {
    const result = await client.query<{ blocked: boolean }>(
      "select exists(select 1 from orders where customer_id = $1 and status not in ('Completed', 'Cancelled')) as blocked",
      [id],
    )
    return result.rows[0]?.blocked === true
  }
  if (moduleId === 'suppliers') {
    const result = await client.query<{ blocked: boolean }>(
      "select exists(select 1 from products where supplier_id = $1 and deleted_at is null and status = 'Active') as blocked",
      [id],
    )
    return result.rows[0]?.blocked === true
  }
  return false
}

export async function insertManagedRecordAudit(
  client: PoolClient,
  values: {
    userId: string
    branchId: string | null
    moduleId: ManagedModuleId
    entityId: string
    action: string
    oldValue: Record<string, unknown>
    newValue: Record<string, unknown>
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    `insert into audit_logs
      (user_id, branch_id, action, entity_type, entity_id, old_value, new_value, ip_address, request_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      values.userId,
      values.branchId,
      values.action,
      values.moduleId,
      values.entityId,
      values.oldValue,
      values.newValue,
      values.ipAddress,
      values.requestId,
    ],
  )
}

export async function getManagedRecordHistory(
  moduleId: ManagedModuleId,
  id: string,
  branchId: string | null,
) {
  if (branchId === 'none') return []
  const result = await pool.query(
    `select a.id::text as id, a.action, a.old_value as "oldValue", a.new_value as "newValue",
            a.created_at as "createdAt", u.name as "actorName"
     from audit_logs a join users u on u.id = a.user_id
     where a.entity_type = $1 and a.entity_id = $2
       and ($3::uuid is null or a.branch_id = $3)
     order by a.created_at desc limit 25`,
    [moduleId, id, branchId],
  )
  return result.rows
}

export async function getManagedRecordRelated(
  moduleId: ManagedModuleId,
  id: string,
  permissions: readonly string[],
  branchId: string | null,
) {
  if (moduleId === 'branches') {
    const [employees, inventory, orders] = await Promise.all([
      permissions.includes('employees.read')
        ? pool.query<{ total: string }>(
            'select count(*)::text as total from employees where branch_id = $1 and deleted_at is null',
            [id],
          )
        : null,
      permissions.includes('inventory.read')
        ? pool.query<{ total: string }>(
            'select count(*)::text as total from inventory where branch_id = $1 and quantity > 0',
            [id],
          )
        : null,
      permissions.includes('sales.read')
        ? pool.query<{ total: string }>(
            'select count(*)::text as total from orders where branch_id = $1',
            [id],
          )
        : null,
    ])
    return {
      ...(employees ? { employeeCount: Number(employees.rows[0]?.total ?? 0) } : {}),
      ...(inventory ? { stockedProductCount: Number(inventory.rows[0]?.total ?? 0) } : {}),
      ...(orders ? { orderCount: Number(orders.rows[0]?.total ?? 0) } : {}),
    }
  }
  if (moduleId === 'customers' && permissions.includes('sales.read')) {
    if (branchId === 'none') return { orderCount: 0 }
    const result = await pool.query<{ total: string }>(
      'select count(*)::text as total from orders where customer_id = $1 and ($2::uuid is null or branch_id = $2)',
      [id, branchId],
    )
    return { orderCount: Number(result.rows[0]?.total ?? 0) }
  }
  if (moduleId === 'suppliers' && permissions.includes('products.read')) {
    const result = await pool.query<{ total: string }>(
      'select count(*)::text as total from products where supplier_id = $1 and deleted_at is null',
      [id],
    )
    return { productCount: Number(result.rows[0]?.total ?? 0) }
  }
  if (moduleId === 'products' && permissions.includes('inventory.read')) {
    if (branchId === 'none') return { inventory: [] }
    const result = await pool.query(
      `select i.branch_id::text as "branchId", b.name as "branchName",
              i.quantity::text as quantity, i.reorder_level::text as "reorderLevel"
       from inventory i join branches b on b.id = i.branch_id
       where i.product_id = $1 and b.deleted_at is null
         and ($2::uuid is null or i.branch_id = $2)
       order by b.name`,
      [id, branchId],
    )
    return { inventory: result.rows }
  }
  return {}
}
