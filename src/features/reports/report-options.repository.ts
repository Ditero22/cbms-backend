import { pool } from '@/database/client.js'
import { requireReportAccess } from './reports.access.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

export async function getReportOptions(user: AuthenticatedUser, requestedBranchId?: string) {
  const assignedBranchId = requireReportAccess(user)
  const branchId = user.isCrossBranch ? (requestedBranchId ?? null) : (assignedBranchId ?? null)
  const fleet =
    user.permissions.includes('vehicles.assign') ||
    user.permissions.includes('vehicles.maintenance') ||
    user.permissions.includes('driver-allowances.read') ||
    user.permissions.includes('vehicles.read')
  const financial =
    user.permissions.includes('payments.read') ||
    user.permissions.includes('driver-allowances.read') ||
    user.permissions.includes('vehicles.assign')
  const [branches, vehicles, drivers, customers] = await Promise.all([
    user.isCrossBranch
      ? pool.query<{ id: string; name: string }>(
          `select id,name from branches where status='Active' and deleted_at is null order by name,id`,
        )
      : null,
    fleet
      ? pool.query<{ id: string; name: string }>(
          `select v.id, v.name || ' · ' || v.plate_number as name from vehicles v where ($1::uuid is null or v.branch_id=$1) order by v.name,v.id limit 500`,
          [branchId],
        )
      : null,
    fleet
      ? pool.query<{ id: string; name: string }>(
          `select e.id,e.name || ' · ' || e.employee_number as name from employees e where ($1::uuid is null or e.branch_id=$1) and (e.is_driver=1 or exists(select 1 from vehicle_assignments a where a.driver_id=e.id and ($1::uuid is null or a.branch_id=$1)) or exists(select 1 from driver_allowances a where a.worker_id=e.id and ($1::uuid is null or a.branch_id=$1))) order by name,e.id limit 500`,
          [branchId],
        )
      : null,
    financial
      ? pool.query<{ id: string; name: string }>(
          `select c.id,c.name from customers c where ($1::uuid is null or c.branch_id=$1) order by c.name,c.id limit 500`,
          [branchId],
        )
      : null,
  ])
  return {
    branches: branches?.rows ?? [],
    vehicles: vehicles?.rows ?? [],
    drivers: drivers?.rows ?? [],
    customers: customers?.rows ?? [],
  }
}
