import { getModuleRows } from '@/features/records/record.repository.js'
import {
  moduleListQuerySchema,
  getProjectedAliases,
} from '@/features/records/record-list.schema.js'
import type { ModuleModel } from '@/features/records/record-models.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import { AppError } from '@/shared/errors/AppError.js'
import { requirePermission } from './fleet.repository.js'

const models: Record<string, ModuleModel> = {
  vehicles: {
    permission: 'vehicles.read',
    branchFilter: 'v.branch_id = $1',
    searchFields: ['Vehicle', 'Plate number', 'Type', 'Default driver', 'Status', 'Branch'],
    query: `select v.id::text as "id",v.name as "Vehicle",v.plate_number as "Plate number",v.vehicle_type as "Type",case when v.capacity_value is null then 'Not recorded' else rtrim(rtrim(to_char(v.capacity_value,'FM999,999,999,990.000'),'0'),'.')||' '||v.capacity_unit end as "Capacity",coalesce(e.name,v.assigned_driver,'Unassigned') as "Default driver",b.name as "Branch",v.status as "Status" from vehicles v left join employees e on e.id=v.default_driver_id left join branches b on b.id=v.branch_id where v.deleted_at is null order by v.name`,
  },
  'vehicle-assignments': {
    permission: 'vehicles.assign',
    branchFilter: 'a.branch_id = $1',
    searchFields: ['Assignment', 'Vehicle', 'Driver', 'Destination', 'Status'],
    query: `select a.id::text as "id",a.reference as "Assignment",v.name as "Vehicle",e.name as "Driver",a.destination as "Destination",a.status as "Status" from vehicle_assignments a join vehicles v on v.id=a.vehicle_id join employees e on e.id=a.driver_id order by a.created_at desc`,
  },
  'driver-allowances': {
    permission: 'driver-allowances.read',
    branchFilter: 'a.branch_id = $1',
    searchFields: ['Transaction', 'Driver', 'Type', 'Status'],
    sortExpressions: { Amount: `regexp_replace("Amount", '[^0-9.-]', '', 'g')::numeric` },
    query: `select a.id::text as "id",a.reference as "Transaction",e.name as "Driver",a.payment_type as "Type",'₱'||to_char(a.amount,'FM999,999,999,990.00') as "Amount",to_char(a.created_at,'Mon DD, YYYY') as "Date",a.status as "Status" from driver_allowances a join employees e on e.id=a.worker_id order by a.created_at desc`,
  },
}
export async function listFleetRecords(moduleId: string, input: unknown, user: AuthenticatedUser) {
  const model = models[moduleId]!
  requirePermission(user, model.permission)
  const parsed = moduleListQuerySchema.safeParse(input)
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'The list query is invalid.')
  const assignedBranchId = getAssignedBranchScope(user)
  if (model.branchFilter && !user.isCrossBranch && !assignedBranchId)
    throw new AppError(403, 'BRANCH_FORBIDDEN', 'Your account needs an assigned branch.')
  if (parsed.data.sort && !getProjectedAliases(model.query).has(parsed.data.sort))
    throw new AppError(400, 'INVALID_SORT', 'Choose a supported sort field.')
  return getModuleRows(
    model,
    model.branchFilter ? (user.isCrossBranch ? parsed.data.branchId : assignedBranchId) : undefined,
    parsed.data,
  )
}
