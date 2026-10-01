import { pool } from '@/database/client.js'
import { withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import type { VehicleInput } from './fleet.schemas.js'
import * as repository from './fleet.repository.js'
import type { FleetContext } from './fleet.repository.js'
import { getVehicleActivity, type VehicleActivityPages } from './vehicle-activity.repository.js'

function requireVehicle(user: AuthenticatedUser, key: string) {
  repository.requirePermission(user, key)
  if (!user.isCrossBranch && !user.branchId)
    throw new AppError(403, 'BRANCH_FORBIDDEN', 'Your account needs an assigned branch.')
}
async function resolveVehicleBranch(
  branchId: string | undefined,
  user: AuthenticatedUser,
  client: import('pg').PoolClient,
) {
  const resolvedBranchId = user.isCrossBranch ? branchId : user.branchId
  if (!resolvedBranchId)
    throw new AppError(400, 'BRANCH_REQUIRED', 'Choose a branch for this vehicle.')
  if (branchId && !user.isCrossBranch && branchId !== user.branchId)
    throw new AppError(403, 'BRANCH_FORBIDDEN', 'Choose your assigned branch.')
  await repository.validateBranch(client, resolvedBranchId, user)
  return resolvedBranchId
}
function rethrowVehicleError(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
    throw new AppError(409, 'DUPLICATE_VEHICLE', 'A vehicle with that plate number already exists.')
  throw error
}
export async function getVehicleDetail(
  id: string,
  user: AuthenticatedUser,
  historyPage = 1,
  pages: VehicleActivityPages = {},
) {
  requireVehicle(user, 'vehicles.read')
  const vehicle = repository.scopeVehicle(await repository.fetchRecord('vehicles', id), user)
  if (!vehicle) throw new AppError(404, 'RECORD_NOT_FOUND', 'Vehicle not found.')
  const driver = vehicle.defaultDriverId
    ? await pool.query(
        `select name from employees where id=$1 and ($2::uuid is null or branch_id=$2)`,
        [vehicle.defaultDriverId, user.isCrossBranch ? null : vehicle.branchId],
      )
    : null
  return {
    vehicle: { ...vehicle, defaultDriverName: driver?.rows[0]?.name ?? null },
    ...(await getVehicleActivity(
      id,
      user.permissions.includes('vehicles.maintenance') &&
        user.permissions.includes('expenses.read'),
      user.permissions.includes('vehicles.assign'),
      pages,
      user.isCrossBranch ? null : user.branchId,
    )),
    ...(await repository.historyResponse('vehicles', id, user, historyPage)),
  }
}
async function validateVehicle(
  input: { [K in keyof VehicleInput]?: VehicleInput[K] | undefined },
  current: Record<string, unknown>,
  branchId: string | null,
  client: import('pg').PoolClient,
) {
  const next = { ...current, ...input }
  if (Boolean(next.capacityValue) !== Boolean(next.capacityUnit))
    throw new AppError(400, 'CAPACITY_UNIT_REQUIRED', 'Record capacity and its unit together.')
  if (next.defaultDriverId) {
    const driver = await client.query(
      `select id from employees where id=$1 and ($2::uuid is null or branch_id=$2) and deleted_at is null and status='Active' and is_driver=1 for key share`,
      [next.defaultDriverId, branchId],
    )
    if (driver.rowCount !== 1)
      throw new AppError(400, 'INVALID_DRIVER', 'Choose an active worker with driver capability.')
  }
}
export async function createVehicle(input: VehicleInput, context: FleetContext) {
  requireVehicle(context.user, 'vehicles.create')
  try {
    return await withTransaction(async (client) => {
      const branchId = await resolveVehicleBranch(input.branchId, context.user, client)
      await validateVehicle(input, {}, branchId, client)
      const id = await repository.insertRecord(client, 'vehicles', {
        ...input,
        branchId,
        status: 'Available',
      })
      await repository.audit(
        client,
        context,
        'vehicles',
        id,
        branchId,
        'created vehicle',
        null,
        input,
      )
      return { id }
    })
  } catch (error) {
    rethrowVehicleError(error)
  }
}
export async function updateVehicle(
  id: string,
  input: { [K in keyof VehicleInput]?: VehicleInput[K] | undefined },
  context: FleetContext,
) {
  requireVehicle(context.user, 'vehicles.update')
  return withTransaction(async (client) => {
    const current = repository.scopeVehicle(
      await repository.fetchRecord('vehicles', id, client, true),
      context.user,
    )
    await validateVehicle(
      input,
      current,
      typeof current.branchId === 'string' ? current.branchId : null,
      client,
    )
    await repository.updateRecord(client, 'vehicles', id, input)
    const vehicle = await repository.fetchRecord('vehicles', id, client)
    await repository.audit(
      client,
      context,
      'vehicles',
      id,
      typeof current.branchId === 'string' ? current.branchId : null,
      'updated vehicle',
      current,
      vehicle,
    )
    return { id }
  }).catch(rethrowVehicleError)
}
export async function changeVehicleStatus(id: string, status: string, context: FleetContext) {
  requireVehicle(context.user, 'vehicles.update')
  return withTransaction(async (client) => {
    const current = repository.scopeVehicle(
      await repository.fetchRecord('vehicles', id, client, true),
      context.user,
    )
    const assignments = await client.query(
      `select id from vehicle_assignments where vehicle_id=$1 and status in ('Scheduled','Active')`,
      [id],
    )
    if (assignments.rowCount)
      throw new AppError(
        409,
        'VEHICLE_ASSIGNED',
        'Finish or cancel the active assignment before changing vehicle availability.',
      )
    const maintenance = await client.query(
      `select id from vehicle_maintenance where vehicle_id=$1 and status='In Progress'`,
      [id],
    )
    if (maintenance.rowCount && status !== 'Under Maintenance')
      throw new AppError(
        409,
        'MAINTENANCE_ACTIVE',
        'Complete or cancel in-progress maintenance first.',
      )
    await repository.updateRecord(client, 'vehicles', id, {
      status,
      manualStatus: status === 'Available' ? null : status,
    })
    await repository.audit(
      client,
      context,
      'vehicles',
      id,
      typeof current.branchId === 'string' ? current.branchId : null,
      'changed vehicle status',
      current,
      { ...current, status },
    )
    return { id, status }
  })
}
export async function archiveVehicle(id: string, context: FleetContext) {
  requireVehicle(context.user, 'vehicles.update')
  return withTransaction(async (client) => {
    const current = repository.scopeVehicle(
      await repository.fetchRecord('vehicles', id, client, true),
      context.user,
    )
    const live = await client.query(
      `select exists(select 1 from vehicle_assignments where vehicle_id=$1 and status in ('Scheduled','Active')) or exists(select 1 from vehicle_maintenance where vehicle_id=$1 and status in ('Scheduled','In Progress')) as blocked`,
      [id],
    )
    if (live.rows[0]?.blocked)
      throw new AppError(
        409,
        'RECORD_IN_USE',
        'Resolve open assignments and maintenance before archiving.',
      )
    await client.query(
      `update vehicles set deleted_at=now(),deleted_by=$2,updated_at=now() where id=$1`,
      [id, context.user.id],
    )
    await repository.audit(
      client,
      context,
      'vehicles',
      id,
      typeof current.branchId === 'string' ? current.branchId : null,
      'archived vehicle',
      current,
      { archived: true },
    )
    return { id }
  })
}
