import { pool } from '@/database/client.js'
import type { ReportQuery } from './reports.schemas.js'
import type { ReportResult } from './reports.repository.js'

const definitions = {
  'fleet-status': {
    title: 'Current fleet availability',
    columns: ['Vehicle', 'Plate', 'Type', 'Capacity', 'Driver', 'Status'],
    query: `select v.name as "Vehicle", v.plate_number as "Plate", v.vehicle_type as "Type", coalesce(v.capacity_value::text || ' ' || v.capacity_unit, '—') as "Capacity", coalesce(e.name, v.assigned_driver, '—') as "Driver", v.status as "Status"
      from vehicles v left join vehicle_assignments a on a.vehicle_id=v.id and a.status in ('Scheduled','Active') and ($3::uuid is null or a.branch_id=$3) left join employees e on e.id=coalesce(a.driver_id,v.default_driver_id) and ($3::uuid is null or e.branch_id=$3) where v.deleted_at is null and ($3::uuid is null or v.branch_id=$3) and ($4::uuid is null or v.id=$4) and ($5::uuid is null or coalesce(a.driver_id,v.default_driver_id)=$5) and ($6::text is null or v.status=$6) order by v.name,v.id`,
  },
  'fleet-assignments': {
    title: 'Driver trips and fleet assignment history',
    columns: [
      'Reference',
      'Vehicle',
      'Plate',
      'Driver',
      'Branch',
      'Customer',
      'Destination',
      'Purpose',
      'Scheduled',
      'Started',
      'Ended',
      'Status',
    ],
    query: `select a.reference as "Reference", v.name as "Vehicle", v.plate_number as "Plate", e.name as "Driver", b.name as "Branch", coalesce(c.name,'—') as "Customer", a.destination as "Destination", a.purpose as "Purpose", coalesce(a.scheduled_at::text,'—') as "Scheduled", coalesce(a.started_at::text,'—') as "Started", coalesce(a.ended_at::text,'—') as "Ended", a.status as "Status"
      from vehicle_assignments a join vehicles v on v.id=a.vehicle_id join employees e on e.id=a.driver_id join branches b on b.id=a.branch_id left join deliveries d on d.id=a.delivery_id left join orders o on o.id=d.order_id left join customers c on c.id=o.customer_id
      where (coalesce(a.started_at,a.scheduled_at,a.created_at) at time zone 'Asia/Manila')::date between $1::date and $2::date and ($3::uuid is null or (a.branch_id=$3 and v.branch_id=$3 and e.branch_id=$3)) and ($4::uuid is null or a.vehicle_id=$4) and ($5::uuid is null or a.driver_id=$5) and ($6::text is null or a.status=$6) and ($7::uuid is null or o.customer_id=$7) order by a.created_at desc,a.id desc`,
  },
  'fleet-maintenance': {
    title: 'Maintenance & repair expenses (recorded costs)',
    columns: [
      'Reference',
      'Vehicle',
      'Plate',
      'Branch',
      'Type',
      'Problem',
      'Provider',
      'Started',
      'Completed',
      'Labor (PHP)',
      'Parts (PHP)',
      'Other (PHP)',
      'Total (PHP)',
      'Status',
      'Expense status',
      'Proof files',
    ],
    query: `select m.reference as "Reference", v.name as "Vehicle", v.plate_number as "Plate", b.name as "Branch", m.maintenance_type as "Type", coalesce(m.problem_reported,m.description) as "Problem", coalesce(m.service_provider,'—') as "Provider", coalesce(m.started_on,'—') as "Started", coalesce(m.completed_on,'—') as "Completed", m.labor_cost::text as "Labor (PHP)", m.parts_cost::text as "Parts (PHP)", m.other_cost::text as "Other (PHP)", (m.labor_cost+m.parts_cost+m.other_cost)::text as "Total (PHP)", m.status as "Status", coalesce(x.status,case when m.status='Completed' then 'No expense (zero cost)' when m.status='Cancelled' then 'Cancelled estimate' else 'Open estimate' end) as "Expense status", (select count(*)::text from attachments p where p.entity_type='vehicle-maintenance' and p.entity_id=m.id) as "Proof files"
      from vehicle_maintenance m join vehicles v on v.id=m.vehicle_id join branches b on b.id=m.branch_id left join expenses x on x.id=m.expense_id
      where coalesce(m.started_on,(m.created_at at time zone 'Asia/Manila')::date::text)::date between $1::date and $2::date and ($3::uuid is null or (m.branch_id=$3 and v.branch_id=$3)) and ($4::uuid is null or m.vehicle_id=$4) and ($6::text is null or m.status=$6) order by m.created_at desc,m.id desc`,
  },
  'driver-allowances': {
    title: 'Driver allowances, release and receipt history',
    columns: [
      'Reference',
      'Worker',
      'Branch',
      'Trip',
      'Type',
      'Amount (PHP)',
      'Timing',
      'Method',
      'Status',
      'Authorized',
      'Released',
      'Received',
      'Released by',
      'Confirmed by',
      'Proof files',
    ],
    query: `select a.reference as "Reference", e.name as "Worker", b.name as "Branch", coalesce(t.reference,d.reference,'—') as "Trip", a.payment_type as "Type", a.amount::text as "Amount (PHP)", a.payment_timing as "Timing", a.method as "Method", a.status as "Status", coalesce(a.authorized_at::text,'—') as "Authorized", coalesce(a.released_at::text,'—') as "Released", coalesce(a.received_at::text,'—') as "Received", coalesce(r.name,'—') as "Released by", coalesce(u.name,'—') as "Confirmed by", (select count(*)::text from attachments p where p.entity_type='driver-allowance' and p.entity_id=a.id) as "Proof files"
      from driver_allowances a join employees e on e.id=a.worker_id join branches b on b.id=a.branch_id left join lateral (select trip.* from vehicle_assignments trip where (trip.id=a.assignment_id or (a.assignment_id is null and trip.delivery_id=a.delivery_id and trip.driver_id=a.worker_id)) and ($3::uuid is null or (trip.branch_id=$3 and exists(select 1 from vehicles v where v.id=trip.vehicle_id and v.branch_id=$3))) order by trip.created_at desc,trip.id desc limit 1) t on true left join deliveries d on d.id=coalesce(a.delivery_id,t.delivery_id) left join orders o on o.id=d.order_id left join users r on r.id=a.released_by left join users u on u.id=a.confirmed_by
      where (a.created_at at time zone 'Asia/Manila')::date between $1::date and $2::date and ($3::uuid is null or (a.branch_id=$3 and e.branch_id=$3)) and ($4::uuid is null or t.vehicle_id=$4) and ($5::uuid is null or a.worker_id=$5) and ($6::text is null or a.status=$6) and ($7::uuid is null or o.customer_id=$7) order by a.created_at desc,a.id desc`,
  },
}

export async function queryFleetReport(
  input: ReportQuery,
  branchId?: string,
): Promise<ReportResult> {
  const definition = definitions[input.report as keyof typeof definitions]
  const params: unknown[] = [
    input.dateFrom,
    input.dateTo,
    branchId ?? null,
    input.vehicleId ?? null,
    input.driverId ?? null,
    input.status ?? null,
    input.customerId ?? null,
  ]
  // Bind unused inputs too; PostgreSQL needs their types when the same filter contract is used by every report.
  const typedInputs =
    'with filters as (select $1::date date_from,$2::date date_to,$3::uuid branch_id,$4::uuid vehicle_id,$5::uuid driver_id,$6::text status,$7::uuid customer_id) '
  const rows = (await pool.query<Record<string, string>>(typedInputs + definition.query, params))
    .rows
  return {
    title: definition.title,
    columns: definition.columns,
    rows,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    generatedAt: new Date().toISOString(),
  }
}
