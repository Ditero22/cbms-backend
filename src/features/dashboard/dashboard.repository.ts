import { pool } from '@/database/client.js'
import { remainingOrderValueSql as remainingOrderValue } from '@/features/orders/order-value.sql.js'

export async function getSalesSummary(branchId: string | null) {
  const result = await pool.query<{ salesTotal: string; openOrders: number }>(
    `select coalesce(sum(${remainingOrderValue}), 0)::text as "salesTotal",
      count(*) filter (where o.status not in ('Completed', 'Cancelled'))::int as "openOrders"
     from orders o
     where ($1::uuid is null or o.branch_id = $1)`,
    [branchId],
  )
  return result.rows[0] ?? { salesTotal: '0', openOrders: 0 }
}

export async function getBranchSales(branchId: string | null) {
  const result = await pool.query<{ name: string; total: string }>(
    `select b.name, sum(${remainingOrderValue})::text as total
     from orders o
     join branches b on b.id = o.branch_id
     where ($1::uuid is null or o.branch_id = $1)
     group by b.id, b.name
     order by sum(${remainingOrderValue}) desc, b.name asc
     limit 4`,
    [branchId],
  )
  return result.rows
}

export async function getRecentOrders(branchId: string | null) {
  const result = await pool.query(
    `select o.order_number as "Order", c.name as "Customer",
      to_char(o.created_at, 'Mon DD, YYYY') as "Date",
      '₱' || to_char(
        ${remainingOrderValue},
        'FM999,999,990.00'
      ) as "Amount",
      o.status as "Status"
     from orders o
     join customers c on c.id = o.customer_id
     where ($1::uuid is null or o.branch_id = $1)
     order by o.created_at desc
     limit 5`,
    [branchId],
  )
  return result.rows as Record<string, string>[]
}

export async function getInventorySummary(branchId: string | null) {
  const result = await pool.query<{ stockAlerts: number }>(
    `select count(*) filter (where i.quantity <= i.reorder_level)::int as "stockAlerts"
     from inventory i
     where ($1::uuid is null or i.branch_id = $1)`,
    [branchId],
  )
  return result.rows[0]?.stockAlerts ?? 0
}

export async function getInventoryTasks(branchId: string | null) {
  const result = await pool.query<{ title: string; text: string; meta: string }>(
    `select case when i.quantity = 0 then 'Out of stock' else 'Low stock' end as title,
      p.name || ' · ' || b.name as text,
      i.quantity || ' ' || p.unit || ' on hand' as meta
     from inventory i
     join products p on p.id = i.product_id
     join branches b on b.id = i.branch_id
     where i.quantity <= i.reorder_level
       and ($1::uuid is null or i.branch_id = $1)
     order by (i.quantity = 0) desc, i.quantity asc, p.name asc
     limit 3`,
    [branchId],
  )
  return result.rows
}

export async function getActiveEmployeeCount(branchId: string | null) {
  const result = await pool.query<{ activeEmployees: number }>(
    `select count(*)::int as "activeEmployees"
     from employees e
     where e.deleted_at is null and e.status = 'Active'
       and ($1::uuid is null or e.branch_id = $1)`,
    [branchId],
  )
  return result.rows[0]?.activeEmployees ?? 0
}

export async function getExpenseTasks(branchId: string | null) {
  const result = await pool.query<{ title: string; text: string; meta: string }>(
    `select 'Expense requires review' as title,
      e.description || ' · ' || b.name as text,
      '₱' || to_char(e.amount, 'FM999,999,999,990.00') || ' · ' || u.name as meta
     from expenses e
     join branches b on b.id = e.branch_id
     join users u on u.id = e.submitted_by
     where e.status in ('Pending', 'Review')
       and ($1::uuid is null or e.branch_id = $1)
     order by e.created_at desc
     limit 2`,
    [branchId],
  )
  return result.rows
}

export async function getFleetAvailability(branchId: string | null) {
  const result = await pool.query<{
    available: number
    onService: number
    underMaintenance: number
    unavailable: number
  }>(
    `select count(*) filter(where status='Available')::int as available,count(*) filter(where status='On Service')::int as "onService",count(*) filter(where status='Under Maintenance')::int as "underMaintenance",count(*) filter(where status='Unavailable')::int as unavailable from vehicles where deleted_at is null and ($1::uuid is null or branch_id=$1)`,
    [branchId],
  )
  return result.rows[0]!
}
export async function getMonthlyMaintenanceCost(branchId: string | null) {
  const result = await pool.query<{ amount: string }>(
    `select coalesce(sum(labor_cost+parts_cost+other_cost),0)::text as amount from vehicle_maintenance where status='Completed' and completed_on::date >= date_trunc('month', now() at time zone 'Asia/Manila')::date and completed_on::date < (date_trunc('month',now() at time zone 'Asia/Manila')+interval '1 month')::date and ($1::uuid is null or branch_id=$1)`,
    [branchId],
  )
  return result.rows[0]?.amount ?? '0.00'
}
export async function getPendingAllowances(branchId: string | null) {
  const result = await pool.query<{ count: number; amount: string; awaitingReceipt: number }>(
    `select count(*) filter(where status in ('Pending','Approved'))::int as count,coalesce(sum(amount) filter(where status in ('Pending','Approved')),0)::text as amount,count(*) filter(where status='Released')::int as "awaitingReceipt" from driver_allowances where ($1::uuid is null or branch_id=$1)`,
    [branchId],
  )
  return result.rows[0]!
}
