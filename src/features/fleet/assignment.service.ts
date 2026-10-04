import type { PoolClient } from 'pg'
import { pool } from '@/database/client.js'
import { withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import { quantityToMilli } from '@/shared/domain/fixed-point.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import type { AssignmentInput } from './fleet.schemas.js'
import * as repository from './fleet.repository.js'
import type { FleetContext, FleetRecord } from './fleet.repository.js'

async function lockResources(
  client: PoolClient,
  vehicleId: string,
  driverId: string,
  branchId: string,
  user: AuthenticatedUser,
) {
  const vehicle = await repository.fetchRecord('vehicles', vehicleId, client, true)
  if (!vehicle) throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Choose an existing vehicle.')
  if (!user.isCrossBranch && vehicle.branchId !== branchId)
    throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Choose a vehicle assigned to this branch.')
  const driver = await client.query<{
    name: string
    status: string
    isDriver: number
    availability: string
    expiry: string | null
    branchId: string
  }>(
    `select name,status,is_driver as "isDriver",driver_availability as availability,license_expires_on as expiry,branch_id as "branchId" from employees where id=$1 and deleted_at is null for update`,
    [driverId],
  )
  const worker = driver.rows[0]
  if (
    !worker ||
    worker.status !== 'Active' ||
    worker.isDriver !== 1 ||
    worker.availability !== 'Available' ||
    worker.branchId !== branchId
  )
    throw new AppError(
      409,
      'DRIVER_UNAVAILABLE',
      'Choose an active, available driver from this branch.',
    )
  if (
    worker.expiry &&
    worker.expiry < new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())
  )
    throw new AppError(409, 'DRIVER_LICENSE_EXPIRED', 'The recorded driver license has expired.')
  return { vehicle, worker }
}
export async function createAssignmentInTransaction(
  client: PoolClient,
  input: AssignmentInput,
  context: FleetContext,
  deliveryLinked = false,
) {
  repository.requirePermission(context.user, 'vehicles.assign')
  await repository.validateBranch(client, input.branchId, context.user)
  if (input.deliveryId && !deliveryLinked)
    throw new AppError(
      409,
      'USE_DELIVERY_ASSIGNMENT',
      'Assign delivery resources through delivery scheduling.',
    )
  const { vehicle, worker } = await lockResources(
    client,
    input.vehicleId,
    input.driverId,
    input.branchId,
    context.user,
  )
  if (vehicle.status !== 'Available')
    throw new AppError(
      409,
      'VEHICLE_UNAVAILABLE',
      `This vehicle is ${vehicle.status} and cannot be assigned.`,
    )
  const conflicting = await client.query(
    `select id from vehicle_assignments where (vehicle_id=$1 or driver_id=$2) and status in ('Scheduled','Active') limit 1`,
    [input.vehicleId, input.driverId],
  )
  if (conflicting.rowCount)
    throw new AppError(
      409,
      'ASSIGNMENT_CONFLICT',
      'The driver or vehicle already has a reserved or active assignment.',
    )
  const maintenance = await client.query(
    `select id from vehicle_maintenance where vehicle_id=$1 and status='In Progress' limit 1`,
    [input.vehicleId],
  )
  if (maintenance.rowCount)
    throw new AppError(409, 'MAINTENANCE_ACTIVE', 'Finish vehicle maintenance before assigning it.')
  if (
    input.startOdometer &&
    vehicle.odometer &&
    quantityToMilli(input.startOdometer) < quantityToMilli(String(vehicle.odometer))
  )
    throw new AppError(
      400,
      'ODOMETER_INVALID',
      'Starting odometer cannot be below the current vehicle reading.',
    )
  const id = await repository.insertRecord(client, 'vehicle_assignments', {
    ...input,
    reference: repository.reference('TRIP'),
    status: 'Scheduled',
    createdBy: context.user.id,
  })
  await repository.updateRecord(client, 'vehicles', input.vehicleId, { status: 'On Service' })
  await repository.audit(
    client,
    context,
    'vehicle-assignment',
    id,
    input.branchId,
    'assigned vehicle and driver',
    null,
    { ...input, driverName: worker.name, status: 'Scheduled' },
  )
  await repository.audit(
    client,
    context,
    'vehicles',
    input.vehicleId,
    input.branchId,
    'changed vehicle status',
    vehicle,
    { ...vehicle, status: 'On Service', assignmentId: id },
  )
  return { id, driverName: worker.name, status: 'Scheduled' }
}
export async function createAssignment(input: AssignmentInput, context: FleetContext) {
  return withTransaction((client) => createAssignmentInTransaction(client, input, context))
}
export async function getAssignmentDetail(id: string, user: AuthenticatedUser, historyPage = 1) {
  repository.requirePermission(user, 'vehicles.assign')
  const assignment = repository.scopeRecord(
    await repository.fetchRecord('vehicle_assignments', id),
    user,
  )
  const names = await pool.query(
    `select e.name as "driverName",v.name as "vehicleName",v.plate_number as "plateNumber" from employees e cross join vehicles v where e.id=$1 and v.id=$2 and ($3::uuid is null or v.branch_id=$3)`,
    [assignment.driverId, assignment.vehicleId, user.isCrossBranch ? null : assignment.branchId],
  )
  return {
    assignment: { ...assignment, ...names.rows[0] },
    ...(await repository.historyResponse('vehicle-assignment', id, user, historyPage)),
  }
}
async function transition(
  client: PoolClient,
  current: FleetRecord,
  action: string,
  input: { endOdometer?: string | undefined; notes?: string | null | undefined },
  context: FleetContext,
) {
  const vehicle = await repository.fetchRecord('vehicles', current.vehicleId!, client, true)
  if (!vehicle) throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found.')
  await client.query(`select id from employees where id=$1 for update`, [current.driverId])
  const assignment = repository.scopeRecord(
    await repository.fetchRecord('vehicle_assignments', current.id, client, true),
    context.user,
  )
  if (!context.user.isCrossBranch && vehicle.branchId !== assignment.branchId)
    throw new AppError(404, 'RECORD_NOT_FOUND', 'Assignment not found.')
  if (action === 'start')
    await lockResources(
      client,
      assignment.vehicleId!,
      assignment.driverId!,
      assignment.branchId!,
      context.user,
    )
  const valid =
    action === 'start'
      ? assignment.status === 'Scheduled'
      : action === 'complete'
        ? assignment.status === 'Active'
        : ['Scheduled', 'Active'].includes(assignment.status)
  if (!valid)
    throw new AppError(
      409,
      'INVALID_ASSIGNMENT_TRANSITION',
      'This assignment is no longer eligible for that action.',
    )
  if (
    input.endOdometer &&
    quantityToMilli(input.endOdometer) <
      quantityToMilli(String(assignment.startOdometer ?? vehicle.odometer ?? '0'))
  )
    throw new AppError(
      400,
      'ODOMETER_INVALID',
      'Ending odometer cannot be below the starting/current reading.',
    )
  const status = action === 'start' ? 'Active' : action === 'complete' ? 'Completed' : 'Cancelled'
  await repository.updateRecord(client, 'vehicle_assignments', assignment.id, {
    status,
    endOdometer: input.endOdometer,
    notes: input.notes,
    ...(action === 'start' ? { startedAt: new Date() } : { endedAt: new Date() }),
  })
  if (action !== 'start') {
    const blocked = await client.query(
      `select exists(select 1 from vehicle_maintenance where vehicle_id=$1 and status='In Progress') as blocked`,
      [assignment.vehicleId],
    )
    const nextStatus = blocked.rows[0]?.blocked ? 'Under Maintenance' : 'Available'
    await repository.updateRecord(client, 'vehicles', assignment.vehicleId!, {
      status: nextStatus,
      ...(input.endOdometer ? { odometer: input.endOdometer } : {}),
    })
    await repository.audit(
      client,
      context,
      'vehicles',
      assignment.vehicleId!,
      assignment.branchId!,
      'changed vehicle status',
      vehicle,
      { ...vehicle, status: nextStatus },
    )
  }
  await repository.audit(
    client,
    context,
    'vehicle-assignment',
    assignment.id,
    assignment.branchId!,
    `${action} vehicle assignment`,
    assignment,
    await repository.fetchRecord('vehicle_assignments', assignment.id, client),
  )
  return { id: assignment.id, status }
}
export async function transitionAssignment(
  id: string,
  action: string,
  input: { endOdometer?: string | undefined; notes?: string | null | undefined },
  context: FleetContext,
) {
  repository.requirePermission(context.user, 'vehicles.assign')
  return withTransaction(async (client) => {
    const current = repository.scopeRecord(
      await repository.fetchRecord('vehicle_assignments', id, client),
      context.user,
    )
    if (current.deliveryId)
      throw new AppError(
        409,
        'DELIVERY_MANAGED_ASSIGNMENT',
        'Change the linked delivery status to update this assignment.',
      )
    return transition(client, current, action, input, context)
  })
}
export async function transitionDeliveryAssignment(
  client: PoolClient,
  deliveryId: string,
  status: string,
  context: FleetContext,
  input: { endOdometer?: string | undefined; notes?: string | undefined } = {},
) {
  const result = await client.query<{ id: string }>(
    `select id from vehicle_assignments where delivery_id=$1 and status in ('Scheduled','Active')`,
    [deliveryId],
  )
  if (!result.rows[0]) return
  const current = await repository.fetchRecord('vehicle_assignments', result.rows[0].id, client)
  if (!current) return
  if (status === 'In Transit') await transition(client, current, 'start', {}, context)
  else if (status === 'Delivered') await transition(client, current, 'complete', input, context)
  else if (status === 'Failed') await transition(client, current, 'cancel', input, context)
}
