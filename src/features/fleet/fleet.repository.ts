import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '@/database/client.js'
import { AppError } from '@/shared/errors/AppError.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

export type FleetContext = {
  user: AuthenticatedUser
  ipAddress: string | null
  requestId: string | null
}
export type FleetRecord = Record<string, unknown> & {
  id: string
  status: string
  branchId?: string
  vehicleId?: string
  driverId?: string
  workerId?: string
  deliveryId?: string | null
}
export const vehicleColumns = {
  branchId: 'branch_id',
  name: 'name',
  plateNumber: 'plate_number',
  vehicleType: 'vehicle_type',
  assignedDriver: 'assigned_driver',
  brand: 'brand',
  model: 'model',
  year: 'year',
  color: 'color',
  fuelType: 'fuel_type',
  odometer: 'odometer',
  capacityValue: 'capacity_value',
  capacityUnit: 'capacity_unit',
  defaultDriverId: 'default_driver_id',
  registrationExpiresOn: 'registration_expires_on',
  insuranceProvider: 'insurance_provider',
  insuranceReference: 'insurance_reference',
  insuranceExpiresOn: 'insurance_expires_on',
  manualStatus: 'manual_status',
  nextServiceAt: 'next_service_at',
  notes: 'notes',
  status: 'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
}
export const assignmentColumns = {
  reference: 'reference',
  vehicleId: 'vehicle_id',
  driverId: 'driver_id',
  branchId: 'branch_id',
  deliveryId: 'delivery_id',
  destination: 'destination',
  purpose: 'purpose',
  scheduledAt: 'scheduled_at',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  startOdometer: 'start_odometer',
  endOdometer: 'end_odometer',
  status: 'status',
  notes: 'notes',
  createdBy: 'created_by',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
}
export const maintenanceColumns = {
  reference: 'reference',
  vehicleId: 'vehicle_id',
  branchId: 'branch_id',
  maintenanceType: 'maintenance_type',
  description: 'description',
  problemReported: 'problem_reported',
  startedOn: 'started_on',
  completedOn: 'completed_on',
  serviceProvider: 'service_provider',
  contactPerson: 'contact_person',
  laborCost: 'labor_cost',
  partsCost: 'parts_cost',
  otherCost: 'other_cost',
  receiptReference: 'receipt_reference',
  notes: 'notes',
  status: 'status',
  expenseId: 'expense_id',
  createdBy: 'created_by',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
}
export const allowanceColumns = {
  reference: 'reference',
  workerId: 'worker_id',
  branchId: 'branch_id',
  assignmentId: 'assignment_id',
  deliveryId: 'delivery_id',
  paymentType: 'payment_type',
  amount: 'amount',
  paymentTiming: 'payment_timing',
  method: 'method',
  referenceNumber: 'reference_number',
  notes: 'notes',
  status: 'status',
  authorizedBy: 'authorized_by',
  authorizedAt: 'authorized_at',
  releasedBy: 'released_by',
  releasedAt: 'released_at',
  confirmedBy: 'confirmed_by',
  receivedAt: 'received_at',
  acknowledgement: 'acknowledgement',
  expenseId: 'expense_id',
  createdBy: 'created_by',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
}
const columnsByTable = {
  vehicles: vehicleColumns,
  vehicle_assignments: assignmentColumns,
  vehicle_maintenance: maintenanceColumns,
  driver_allowances: allowanceColumns,
}
export type FleetTable = keyof typeof columnsByTable

export function requirePermission(user: AuthenticatedUser, key: string) {
  if (!user.permissions.includes(key))
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission for this action.')
}
export function requireMaintenance(user: AuthenticatedUser) {
  requirePermission(user, 'vehicles.maintenance')
  requirePermission(user, 'expenses.read')
}
export function scopeRecord(record: FleetRecord | undefined, user: AuthenticatedUser) {
  if (!record || (record.branchId && !user.isCrossBranch && record.branchId !== user.branchId))
    throw new AppError(404, 'RECORD_NOT_FOUND', 'Record not found.')
  return record
}
export function scopeVehicle(record: FleetRecord | undefined, user: AuthenticatedUser) {
  if (!record || (!user.isCrossBranch && record.branchId !== user.branchId))
    throw new AppError(404, 'RECORD_NOT_FOUND', 'Vehicle not found.')
  return record
}
export function assertBranch(user: AuthenticatedUser, branchId: string) {
  if (!user.isCrossBranch && user.branchId !== branchId)
    throw new AppError(403, 'BRANCH_FORBIDDEN', 'Choose your assigned branch.')
}
export function reference(prefix: string) {
  return `${prefix}-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`
}
export function selection(table: FleetTable, alias = '') {
  const prefix = alias ? `${alias}.` : ''
  return (
    `${prefix}id::text as id,` +
    Object.entries(columnsByTable[table])
      .map(([key, column]) => `${prefix}${column} as "${key}"`)
      .join(',')
  )
}
export async function fetchRecord(
  table: FleetTable,
  id: string,
  client?: PoolClient,
  lock = false,
) {
  const result = await (client ?? pool).query<FleetRecord>(
    `select ${selection(table)} from ${table} where id=$1${table === 'vehicles' ? ' and deleted_at is null' : ''}${lock ? ' for update' : ''}`,
    [id],
  )
  return result.rows[0]
}
export async function insertRecord(
  client: PoolClient,
  table: FleetTable,
  fields: Record<string, unknown>,
) {
  const map = columnsByTable[table] as Record<string, string>
  const entries = Object.entries(fields).filter(([key, value]) => key in map && value !== undefined)
  const result = await client.query<{ id: string }>(
    `insert into ${table} (${entries.map(([key]) => map[key]).join(',')}) values (${entries.map((_, i) => `$${i + 1}`).join(',')}) returning id`,
    entries.map(([, value]) => (value === '' ? null : value)),
  )
  if (!result.rows[0]) throw new Error('The record could not be saved.')
  return result.rows[0].id
}
export async function updateRecord(
  client: PoolClient,
  table: FleetTable,
  id: string,
  fields: Record<string, unknown>,
) {
  const map = columnsByTable[table] as Record<string, string>
  const entries = Object.entries(fields).filter(
    ([key, value]) => key in map && value !== undefined && key !== 'updatedAt',
  )
  await client.query(
    `update ${table} set ${entries
      .map(([key], i) => `${map[key]}=$${i + 1}`)
      .concat('updated_at=now()')
      .join(',')} where id=$${entries.length + 1}`,
    [...entries.map(([, value]) => (value === '' ? null : value)), id],
  )
}
export async function audit(
  client: PoolClient,
  context: FleetContext,
  entityType: string,
  id: string,
  branchId: string | null,
  action: string,
  oldValue: unknown,
  newValue: unknown,
) {
  await client.query(
    `insert into audit_logs(user_id,branch_id,entity_type,entity_id,action,old_value,new_value,ip_address,request_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      context.user.id,
      branchId,
      entityType,
      id,
      action,
      oldValue,
      newValue,
      context.ipAddress,
      context.requestId,
    ],
  )
}
export async function historyResponse(
  entityType: string,
  id: string,
  user: AuthenticatedUser,
  historyPage = 1,
) {
  const historyPageSize = 20
  if (!user.permissions.includes('audit.read'))
    return { history: [], historyPage, historyPageSize, historyTotal: 0 }
  const parameters = [entityType, id, user.isCrossBranch ? null : user.branchId]
  const count = await pool.query<{ total: number }>(
    `select count(*)::int as total from audit_logs where entity_type=$1 and entity_id=$2 and ($3::uuid is null or branch_id=$3)`,
    parameters,
  )
  const result = await pool.query(
    `select a.id,a.action,a.old_value as "oldValue",a.new_value as "newValue",a.created_at as "createdAt",u.name as "actorName" from audit_logs a join users u on u.id=a.user_id where a.entity_type=$1 and a.entity_id=$2 and ($3::uuid is null or a.branch_id=$3) order by a.created_at desc,a.id desc limit $4 offset $5`,
    [...parameters, historyPageSize, (historyPage - 1) * historyPageSize],
  )
  return {
    history: result.rows,
    historyPage,
    historyPageSize,
    historyTotal: count.rows[0]?.total ?? 0,
  }
}
export async function validateBranch(
  client: PoolClient,
  branchId: string,
  user: AuthenticatedUser,
) {
  assertBranch(user, branchId)
  const result = await client.query(
    `select id from branches where id=$1 and deleted_at is null and status='Active' for share`,
    [branchId],
  )
  if (result.rowCount !== 1) throw new AppError(400, 'INVALID_BRANCH', 'Choose an active branch.')
}
export async function postExpense(
  client: PoolClient,
  context: FleetContext,
  branchId: string,
  description: string,
  category: string,
  amount: string,
  approved?: { by: string; at: unknown },
) {
  const result = await client.query<{ id: string }>(
    `insert into expenses(branch_id,description,category,amount,submitted_by,status,approved_by,approved_at) values($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [
      branchId,
      description,
      category,
      amount,
      context.user.id,
      approved ? 'Approved' : 'Pending',
      approved?.by ?? null,
      approved?.at ?? null,
    ],
  )
  const id = result.rows[0]?.id
  if (!id) throw new Error('Expense posting failed.')
  await audit(client, context, 'expenses', id, branchId, 'created linked fleet expense', null, {
    description,
    category,
    amount,
    status: approved ? 'Approved' : 'Pending',
  })
  return id
}
