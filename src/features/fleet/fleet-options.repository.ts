import { pool } from '@/database/client.js'
import { AppError } from '@/shared/errors/AppError.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

export async function fleetOptions(user: AuthenticatedUser, forAllowances = false) {
  if (
    !user.permissions.some(
      (key) =>
        [
          'vehicles.read',
          'vehicles.create',
          'vehicles.update',
          'vehicles.assign',
          'vehicles.maintenance',
          'deliveries.create',
        ].includes(key) || key.startsWith('driver-allowances.'),
    )
  )
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission for fleet options.')
  const branchId = getAssignedBranchScope(user) ?? null
  if (!user.isCrossBranch && !branchId)
    throw new AppError(403, 'BRANCH_FORBIDDEN', 'Your account needs an assigned branch.')
  const [drivers, branches, vehicles, deliveries, assignments] = await Promise.all([
    pool.query(
      `select e.id,e.name,e.branch_id as "branchId",case when exists(select 1 from vehicle_assignments a where a.driver_id=e.id and a.status in ('Scheduled','Active')) then 'On assignment' else e.driver_availability end as availability from employees e where e.deleted_at is null and e.status='Active' and e.is_driver=1 ${forAllowances ? '' : "and e.driver_availability='Available' and (e.license_expires_on is null or e.license_expires_on >= (now() at time zone 'Asia/Manila')::date::text)"} and ($1::uuid is null or e.branch_id=$1) order by e.name`,
      [branchId],
    ),
    pool.query(
      `select id,name from branches where deleted_at is null and status='Active' and ($1::uuid is null or id=$1) order by name`,
      [branchId],
    ),
    pool.query(
      `select id,name,branch_id as "branchId",plate_number as "plateNumber",status,capacity_value::text as "capacityValue",capacity_unit as "capacityUnit" from vehicles where deleted_at is null and ($1::uuid is null or branch_id=$1) order by name`,
      [branchId],
    ),
    pool.query(
      `select d.id,d.reference,o.branch_id as "branchId",d.destination from deliveries d join orders o on o.id=d.order_id where ($1::uuid is null or o.branch_id=$1) ${forAllowances ? '' : "and d.status not in ('Delivered','Failed')"} order by d.created_at desc limit 500`,
      [branchId],
    ),
    pool.query(
      `select id,reference,driver_id as "driverId",branch_id as "branchId",delivery_id as "deliveryId" from vehicle_assignments where ($1::uuid is null or branch_id=$1) order by created_at desc limit 500`,
      [branchId],
    ),
  ])
  return {
    drivers: drivers.rows,
    branches: branches.rows,
    vehicles: vehicles.rows,
    deliveries: deliveries.rows,
    assignments: assignments.rows,
    vehicleTypes: [
      'Water Truck',
      'Dump Truck',
      'Delivery Truck',
      'Cargo Truck',
      'Pickup',
      'Van',
      'Service Vehicle',
      'Heavy Equipment Transport',
      'Other',
    ],
    capacityUnits: ['L', 'm³', 'tons', 'kg'],
    maintenanceTypes: [
      'Preventive Maintenance',
      'Oil Change',
      'Tire Replacement',
      'Engine Repair',
      'Brake Repair',
      'Electrical Repair',
      'Battery Replacement',
      'Body Repair',
      'General Inspection',
      'Other',
    ],
  }
}
