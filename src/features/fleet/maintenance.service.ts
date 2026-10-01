import { withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { formatMoneyCents, moneyToCents } from '@/features/orders/order.money.js'
import type { MaintenanceInput } from './fleet.schemas.js'
import * as repository from './fleet.repository.js'
import type { FleetContext } from './fleet.repository.js'

function totalCost(record: Record<string, unknown>) {
  const cents = ['laborCost', 'partsCost', 'otherCost'].reduce(
    (sum, key) => sum + moneyToCents(String(record[key] ?? '0')),
    0n,
  )
  if (cents > 99999999999999n)
    throw new AppError(400, 'COST_TOO_LARGE', 'The combined repair expense is too large.')
  return formatMoneyCents(cents)
}
export async function getMaintenanceDetail(id: string, user: AuthenticatedUser, historyPage = 1) {
  repository.requireMaintenance(user)
  const maintenance = repository.scopeRecord(
    await repository.fetchRecord('vehicle_maintenance', id),
    user,
  )
  return {
    maintenance: { ...maintenance, totalCost: totalCost(maintenance) },
    ...(await repository.historyResponse('vehicle-maintenance', id, user, historyPage)),
  }
}
export async function createMaintenance(
  vehicleId: string,
  input: MaintenanceInput,
  context: FleetContext,
) {
  repository.requireMaintenance(context.user)
  return withTransaction(async (client) => {
    await repository.validateBranch(client, input.branchId, context.user)
    const vehicle = await repository.fetchRecord('vehicles', vehicleId, client, true)
    if (!vehicle) throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found.')
    if (!context.user.isCrossBranch && vehicle.branchId !== input.branchId)
      throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Choose a vehicle assigned to this branch.')
    totalCost(input)
    const id = await repository.insertRecord(client, 'vehicle_maintenance', {
      ...input,
      vehicleId,
      reference: repository.reference('MNT'),
      status: 'Scheduled',
      createdBy: context.user.id,
    })
    await repository.audit(
      client,
      context,
      'vehicle-maintenance',
      id,
      input.branchId,
      'created maintenance',
      null,
      input,
    )
    return { id, status: 'Scheduled' }
  })
}
export async function updateMaintenance(
  id: string,
  input: Record<string, unknown>,
  context: FleetContext,
) {
  repository.requireMaintenance(context.user)
  return withTransaction(async (client) => {
    const previous = repository.scopeRecord(
      await repository.fetchRecord('vehicle_maintenance', id, client),
      context.user,
    )
    const vehicle = await repository.fetchRecord('vehicles', previous.vehicleId!, client, true)
    if (!vehicle) throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found.')
    if (!context.user.isCrossBranch && vehicle.branchId !== previous.branchId)
      throw new AppError(404, 'RECORD_NOT_FOUND', 'Maintenance record not found.')
    const current = repository.scopeRecord(
      await repository.fetchRecord('vehicle_maintenance', id, client, true),
      context.user,
    )
    if (!['Scheduled', 'In Progress'].includes(current.status))
      throw new AppError(
        409,
        'MAINTENANCE_CLOSED',
        'Completed or cancelled maintenance cannot be edited.',
      )
    const next = { ...current, ...input }
    totalCost(next)
    await repository.updateRecord(client, 'vehicle_maintenance', id, input)
    await repository.audit(
      client,
      context,
      'vehicle-maintenance',
      id,
      current.branchId!,
      'updated maintenance expense',
      current,
      next,
    )
    return { id }
  })
}
export async function transitionMaintenance(
  id: string,
  action: string,
  input: { startedOn?: string | null | undefined; completedOn?: string | null | undefined },
  context: FleetContext,
) {
  repository.requireMaintenance(context.user)
  return withTransaction(async (client) => {
    const previous = repository.scopeRecord(
      await repository.fetchRecord('vehicle_maintenance', id, client),
      context.user,
    )
    const vehicle = await repository.fetchRecord('vehicles', previous.vehicleId!, client, true)
    if (!vehicle) throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found.')
    if (!context.user.isCrossBranch && vehicle.branchId !== previous.branchId)
      throw new AppError(404, 'RECORD_NOT_FOUND', 'Maintenance record not found.')
    const current = repository.scopeRecord(
      await repository.fetchRecord('vehicle_maintenance', id, client, true),
      context.user,
    )
    const valid =
      action === 'start'
        ? current.status === 'Scheduled'
        : action === 'complete'
          ? current.status === 'In Progress'
          : ['Scheduled', 'In Progress'].includes(current.status)
    if (!valid)
      throw new AppError(
        409,
        'INVALID_MAINTENANCE_TRANSITION',
        'This maintenance record is not eligible for that action.',
      )
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())
    const status =
      action === 'start' ? 'In Progress' : action === 'complete' ? 'Completed' : 'Cancelled'
    const startedOn =
      action === 'start' ? (input.startedOn ?? current.startedOn ?? today) : current.startedOn
    const completedOn = action === 'complete' ? (input.completedOn ?? today) : current.completedOn
    if (
      (action === 'start' && String(startedOn) > today) ||
      (action === 'complete' && String(completedOn) > today)
    )
      throw new AppError(
        400,
        'INVALID_MAINTENANCE_DATE',
        'Actual maintenance dates cannot be in the future.',
      )
    if (startedOn && completedOn && String(completedOn) < String(startedOn))
      throw new AppError(
        400,
        'INVALID_MAINTENANCE_DATE',
        'Completion date cannot precede maintenance start.',
      )
    if (action === 'start') {
      const live = await client.query(
        `select id from vehicle_assignments where vehicle_id=$1 and status in ('Scheduled','Active')`,
        [current.vehicleId],
      )
      if (live.rowCount)
        throw new AppError(
          409,
          'VEHICLE_ASSIGNED',
          'Finish or cancel the current assignment before starting maintenance.',
        )
      await repository.updateRecord(client, 'vehicles', current.vehicleId!, {
        status: 'Under Maintenance',
      })
    }
    const cost = totalCost(current)
    const expenseId =
      action === 'complete' && moneyToCents(cost) > 0n
        ? await repository.postExpense(
            client,
            context,
            current.branchId!,
            `Maintenance ${current.reference}: ${current.description}`,
            'Maintenance & Repair Expenses',
            cost,
          )
        : current.expenseId
    await repository.updateRecord(client, 'vehicle_maintenance', id, {
      status,
      startedOn,
      completedOn,
      expenseId,
    })
    if (action !== 'start' && current.status === 'In Progress') {
      const other = await client.query(
        `select id from vehicle_maintenance where vehicle_id=$1 and status='In Progress'`,
        [current.vehicleId],
      )
      if (!other.rowCount)
        await repository.updateRecord(client, 'vehicles', current.vehicleId!, {
          status: vehicle.manualStatus ?? 'Available',
        })
    }
    await repository.audit(
      client,
      context,
      'vehicle-maintenance',
      id,
      current.branchId!,
      `${action} maintenance`,
      current,
      { ...current, status, startedOn, completedOn, expenseId, totalCost: cost },
    )
    const nextVehicle = await repository.fetchRecord('vehicles', current.vehicleId!, client)
    if (nextVehicle?.status !== vehicle.status)
      await repository.audit(
        client,
        context,
        'vehicles',
        current.vehicleId!,
        current.branchId!,
        'changed vehicle status',
        vehicle,
        nextVehicle,
      )
    return { id, status }
  })
}
