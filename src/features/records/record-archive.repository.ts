import type { Pool, PoolClient } from 'pg'

type ArchiveModuleId = 'branches' | 'products'

type DependencyQuery = {
  key: string
  label: string
  source: string
  blocking?: string
}

export type ArchiveDependency = {
  key: string
  label: string
  count: number
  blockingCount: number
}

export type RecordArchivePolicy = {
  permanentDeletionAllowed: false
  canArchive: boolean
  dependencies: ArchiveDependency[]
}

const branchDependencies: DependencyQuery[] = [
  {
    key: 'accounts',
    label: 'User accounts',
    source: 'from users where branch_id=$1',
    blocking: "deleted_at is null and status='Active'",
  },
  {
    key: 'employees',
    label: 'Employees',
    source: 'from employees where branch_id=$1',
    blocking: "deleted_at is null and status='Active'",
  },
  {
    key: 'customers',
    label: 'Customers',
    source: 'from customers where branch_id=$1',
    blocking: "deleted_at is null and status='Active'",
  },
  {
    key: 'inventory',
    label: 'Inventory records',
    source: 'from inventory where branch_id=$1',
    blocking: 'quantity>0 or reserved_quantity>0',
  },
  {
    key: 'vehicles',
    label: 'Vehicles',
    source: 'from vehicles where branch_id=$1',
    blocking: 'deleted_at is null',
  },
  {
    key: 'orders',
    label: 'Orders',
    source: 'from orders where branch_id=$1',
    blocking: "status not in ('Completed','Cancelled')",
  },
  {
    key: 'deliveries',
    label: 'Deliveries',
    source: 'from deliveries d join orders o on o.id=d.order_id where o.branch_id=$1',
    blocking: "d.status in ('Preparing','Scheduled','In Transit')",
  },
  {
    key: 'assignments',
    label: 'Vehicle assignments',
    source: 'from vehicle_assignments where branch_id=$1',
    blocking: "status in ('Scheduled','Active')",
  },
  {
    key: 'maintenance',
    label: 'Maintenance records',
    source: 'from vehicle_maintenance where branch_id=$1',
    blocking: "status in ('Scheduled','In Progress')",
  },
  {
    key: 'payrollRuns',
    label: 'Pay runs',
    source: `from payroll_runs r where r.branch_id=$1
      or exists(select 1 from payroll_entries e where e.payroll_run_id=r.id and e.branch_id=$1)`,
    blocking: `r.status='Draft' or (r.status='Processed' and (
      exists(select 1 from payroll_entries e where e.payroll_run_id=r.id and e.branch_id=$1 and e.payment_status<>'Received')
      or not exists(select 1 from payroll_entries e where e.payroll_run_id=r.id)))`,
  },
  {
    key: 'payrollEntries',
    label: 'Employee payroll records',
    source: 'from payroll_entries where branch_id=$1',
    blocking: "payment_status in ('Pending','Paid')",
  },
  {
    key: 'allowances',
    label: 'Historical driver allowances',
    source: 'from driver_allowances where branch_id=$1',
    blocking: "status in ('Pending','Approved','Released')",
  },
  {
    key: 'expenses',
    label: 'Expenses',
    source: 'from expenses where branch_id=$1',
    blocking: "status='Pending'",
  },
  {
    key: 'transfers',
    label: 'Stock transfers',
    source: 'from inventory_transfers where from_branch_id=$1 or to_branch_id=$1',
    blocking: "status<>'Completed'",
  },
  {
    key: 'returns',
    label: 'Returns',
    source: 'from order_returns r join orders o on o.id=r.order_id where o.branch_id=$1',
    blocking: "r.status in ('Requested','Approved')",
  },
  {
    key: 'refunds',
    label: 'Refunds',
    source: 'from payment_refunds r join orders o on o.id=r.order_id where o.branch_id=$1',
    blocking: "r.status in ('Requested','Approved')",
  },
  {
    key: 'payments',
    label: 'Customer payments',
    source: 'from payments p join orders o on o.id=p.order_id where o.branch_id=$1',
  },
  {
    key: 'movements',
    label: 'Stock movements',
    source: 'from inventory_transactions where branch_id=$1',
  },
  {
    key: 'audit',
    label: 'Audit events',
    source: 'from audit_logs where branch_id=$1',
  },
]

const productDependencies: DependencyQuery[] = [
  {
    key: 'inventory',
    label: 'Inventory records',
    source: 'from inventory where product_id=$1',
    blocking: 'quantity>0 or reserved_quantity>0',
  },
  {
    key: 'orders',
    label: 'Orders',
    source:
      'from orders o where exists(select 1 from order_items i where i.order_id=o.id and i.product_id=$1)',
    blocking: "o.status not in ('Completed','Cancelled')",
  },
  {
    key: 'deliveries',
    label: 'Deliveries',
    source: `from deliveries d where exists(select 1 from delivery_items di
      join order_items oi on oi.id=di.order_item_id where di.delivery_id=d.id and oi.product_id=$1)`,
    blocking: "d.status in ('Preparing','Scheduled','In Transit')",
  },
  {
    key: 'transfers',
    label: 'Stock transfers',
    source: `from inventory_transfers t where exists(select 1 from inventory_transfer_items i
      where i.transfer_id=t.id and i.product_id=$1)`,
    blocking: "t.status<>'Completed'",
  },
  {
    key: 'returns',
    label: 'Returns',
    source: `from order_returns r where exists(select 1 from order_return_items ri
      join order_items oi on oi.id=ri.order_item_id where ri.return_id=r.id and oi.product_id=$1)`,
    blocking: "r.status in ('Requested','Approved')",
  },
  {
    key: 'payments',
    label: 'Customer payments',
    source: `from payments p where exists(select 1 from order_items i
      where i.order_id=p.order_id and i.product_id=$1)`,
  },
  {
    key: 'movements',
    label: 'Stock movements',
    source: 'from inventory_transactions where product_id=$1',
  },
  {
    key: 'audit',
    label: 'Audit events',
    source: `from audit_logs a where (a.entity_type='products' and a.entity_id=$1)
      or (a.entity_type='inventory' and (a.entity_id=$1
        or exists(select 1 from inventory i where i.id=a.entity_id and i.product_id=$1)))`,
  },
]

export async function getRecordArchivePolicy(
  client: Pool | PoolClient,
  moduleId: ArchiveModuleId,
  id: string,
): Promise<RecordArchivePolicy> {
  const definitions = moduleId === 'branches' ? branchDependencies : productDependencies
  // All SQL fragments and labels below are fixed definitions; the record ID is bound.
  const sql = definitions
    .map(
      (dependency) => `select '${dependency.key}' as key, '${dependency.label}' as label,
        count(*)::text as count,
        count(*) filter (where ${dependency.blocking ?? 'false'})::text as "blockingCount"
        ${dependency.source}`,
    )
    .join(' union all ')
  const result = await client.query<{
    key: string
    label: string
    count: string
    blockingCount: string
  }>(sql, [id])
  const dependencies = result.rows
    .map((row) => ({ ...row, count: Number(row.count), blockingCount: Number(row.blockingCount) }))
    .filter((row) => row.count > 0)
  return {
    permanentDeletionAllowed: false,
    canArchive: dependencies.every((dependency) => dependency.blockingCount === 0),
    dependencies,
  }
}

export function archiveBlockerMessage(policy: RecordArchivePolicy) {
  const blockers = policy.dependencies
    .filter((dependency) => dependency.blockingCount > 0)
    .map((dependency) => `${dependency.label}: ${dependency.blockingCount}`)
    .join('; ')
  return `Resolve active dependencies before archiving or deactivating this record. ${blockers}. Historical records will be retained.`
}
