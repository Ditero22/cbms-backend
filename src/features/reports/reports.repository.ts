import { pool } from '@/database/client.js'
import { remainingOrderValueSql } from '@/features/orders/order-value.sql.js'
import type { ReportQuery } from './reports.schemas.js'

export type ReportResult = {
  title: string
  columns: string[]
  rows: Record<string, string>[]
  dateFrom: string
  dateTo: string
  generatedAt: string
}

const reportDefinitions = {
  'sales-by-branch': {
    title: 'Completed sales by branch',
    columns: [
      'Branch',
      'Completed orders',
      'Sales (PHP)',
      'Payments (PHP)',
      'Refunds (PHP)',
      'Net collected (PHP)',
    ],
    query: `
      -- This report groups completed orders by their creation date. Sales is the
      -- remaining contractual line value; paid and processed-refund totals are
      -- current collections for those orders, even if collected on a later date.
      with completed_order_amounts as (
        select o.id, o.branch_id, o.created_at,
               ${remainingOrderValueSql} as sales_amount,
               coalesce((select sum(p.amount) from payments p
                          where p.order_id = o.id and p.status = 'Paid'), 0) as payments_amount,
               coalesce((select sum(r.amount) from payment_refunds r
                          where r.order_id = o.id and r.status = 'Processed'), 0) as refunds_amount
          from orders o where o.status = 'Completed'
      )
      select
        b.name as "Branch",
        count(o.id)::text as "Completed orders",
        coalesce(sum(o.sales_amount), 0)::text as "Sales (PHP)",
        coalesce(sum(o.payments_amount), 0)::text as "Payments (PHP)",
        coalesce(sum(o.refunds_amount), 0)::text as "Refunds (PHP)",
        coalesce(sum(o.payments_amount - o.refunds_amount), 0)::text as "Net collected (PHP)"
      from branches b
      left join completed_order_amounts o
        on o.branch_id = b.id
        and o.created_at >= $1::date
        and o.created_at < $2::date + interval '1 day'
      where b.deleted_at is null
        and b.status = 'Active'
        and ($3::uuid is null or b.id = $3)
      group by b.id, b.name
      order by b.name
    `,
  },
  'approved-expenses': {
    title: 'Approved expenses by category',
    columns: ['Branch', 'Category', 'Approved expenses', 'Total (PHP)'],
    query: `
      select
        b.name as "Branch",
        e.category as "Category",
        count(*)::text as "Approved expenses",
        sum(e.amount)::text as "Total (PHP)"
      from expenses e
      join branches b on b.id = e.branch_id
      where e.status = 'Approved'
        and e.created_at >= $1::date
        and e.created_at < $2::date + interval '1 day'
        and ($3::uuid is null or e.branch_id = $3)
      group by b.id, b.name, e.category
      order by b.name, sum(e.amount) desc, e.category
    `,
  },
  'inventory-health': {
    title: 'Current inventory health by branch',
    columns: ['Branch', 'Tracked products', 'Low stock', 'Out of stock'],
    query: `
      select
        b.name as "Branch",
        count(*)::text as "Tracked products",
        count(*) filter (where i.quantity > 0 and i.quantity <= i.reorder_level)::text as "Low stock",
        count(*) filter (where i.quantity = 0)::text as "Out of stock"
      from inventory i
      join products p on p.id = i.product_id
      join branches b on b.id = i.branch_id
      where p.deleted_at is null
        and b.deleted_at is null
        and b.status = 'Active'
        and ($1::uuid is null or i.branch_id = $1)
      group by b.id, b.name
      order by b.name
    `,
  },
} satisfies Record<string, { title: string; columns: string[]; query: string }>

export async function queryReport(
  input: ReportQuery,
  branchId: string | undefined,
): Promise<ReportResult> {
  const definition = reportDefinitions[input.report as keyof typeof reportDefinitions]
  // Inventory health is a current snapshot; only dated reports bind date bounds.
  const parameters =
    input.report === 'inventory-health'
      ? [branchId ?? null]
      : [input.dateFrom, input.dateTo, branchId ?? null]
  const result = await pool.query<Record<string, string>>(definition.query, parameters)

  return {
    title: definition.title,
    columns: definition.columns,
    rows: result.rows,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    generatedAt: new Date().toISOString(),
  }
}

export async function recordReportExport(values: {
  userId: string
  branchId: string | undefined
  reportType: ReportQuery['report']
  title: string
  dateFrom: string
  dateTo: string
  rowCount: number
  filters?: {
    branchId?: string | undefined
    vehicleId?: string | undefined
    driverId?: string | undefined
    customerId?: string | undefined
    status?: string | undefined
  }
  ipAddress: string | null
  requestId: string | null
}) {
  await pool.query(
    `insert into audit_logs
      (user_id, branch_id, action, entity_type, new_value, ip_address, request_id)
     values ($1, $2, 'exported report', 'reports', $3, $4, $5)`,
    [
      values.userId,
      values.branchId ?? null,
      {
        reportType: values.reportType,
        title: values.title,
        dateFrom: values.dateFrom,
        dateTo: values.dateTo,
        rowCount: values.rowCount,
        filters: values.filters ?? {},
      },
      values.ipAddress,
      values.requestId,
    ],
  )
}
