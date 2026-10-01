import { pool } from '@/database/client.js'
import { selection } from './fleet.repository.js'

export const vehicleActivityPageSize = 20
export type VehicleActivityPages = { maintenancePage?: number; assignmentPage?: number }

export async function getVehicleActivity(
  vehicleId: string,
  canReadMaintenance: boolean,
  canReadAssignments: boolean,
  pages: VehicleActivityPages,
  branchId: string | null,
) {
  const maintenancePage = pages.maintenancePage ?? 1
  const assignmentPage = pages.assignmentPage ?? 1
  const maintenanceSelection = `${selection('vehicle_maintenance')},(labor_cost+parts_cost+other_cost)::text as "totalCost"`
  const maintenance = canReadMaintenance
    ? await pool.query(
        `select ${maintenanceSelection} from vehicle_maintenance where vehicle_id=$1 and ($2::uuid is null or branch_id=$2) order by created_at desc,id desc limit $3 offset $4`,
        [
          vehicleId,
          branchId,
          vehicleActivityPageSize,
          (maintenancePage - 1) * vehicleActivityPageSize,
        ],
      )
    : null
  const current = canReadMaintenance
    ? await pool.query(
        `select ${maintenanceSelection} from vehicle_maintenance where vehicle_id=$1 and ($2::uuid is null or branch_id=$2) and status='In Progress' order by updated_at desc,id desc limit 1`,
        [vehicleId, branchId],
      )
    : null
  const maintenanceSummary = canReadMaintenance
    ? await pool.query(
        `select count(*)::int as count,coalesce(sum(labor_cost+parts_cost+other_cost) filter(where status='Completed'),0)::text as total from vehicle_maintenance where vehicle_id=$1 and ($2::uuid is null or branch_id=$2)`,
        [vehicleId, branchId],
      )
    : null
  const assignments = canReadAssignments
    ? await pool.query(
        `select ${selection('vehicle_assignments', 'a')},e.name as "driverName",v.name as "vehicleName",v.plate_number as "plateNumber" from vehicle_assignments a join employees e on e.id=a.driver_id join vehicles v on v.id=a.vehicle_id where a.vehicle_id=$1 and ($2::uuid is null or a.branch_id=$2) order by a.created_at desc,a.id desc limit $3 offset $4`,
        [
          vehicleId,
          branchId,
          vehicleActivityPageSize,
          (assignmentPage - 1) * vehicleActivityPageSize,
        ],
      )
    : null
  const assignmentCount = canReadAssignments
    ? await pool.query(
        `select count(*)::int as count from vehicle_assignments where vehicle_id=$1 and ($2::uuid is null or branch_id=$2)`,
        [vehicleId, branchId],
      )
    : null
  return {
    maintenance: maintenance?.rows ?? [],
    maintenancePage,
    maintenanceTotal: maintenanceSummary?.rows[0]?.count ?? 0,
    assignments: assignments?.rows ?? [],
    assignmentPage,
    assignmentTotal: assignmentCount?.rows[0]?.count ?? 0,
    activityPageSize: vehicleActivityPageSize,
    currentMaintenance: current?.rows[0] ?? null,
    totalMaintenanceCost: maintenanceSummary?.rows[0]?.total ?? '0.00',
  }
}
