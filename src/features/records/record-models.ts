import { remainingOrderValueSql } from '@/features/orders/order-value.sql.js'
import {
  orderPaymentAmountsSql,
  paymentStatusSql,
} from '@/features/payments/payment-balances.sql.js'

export type ModuleModel = {
  permission: string
  query: string
  branchFilter?: string
  unassignedBranchFilter?: string
  searchFields: string[]
  sortExpressions?: Record<string, string>
}

export const models: Record<string, ModuleModel> = {
  users: {
    permission: 'users.read',
    branchFilter: 'u.branch_id = $1',
    searchFields: ['Name', 'Email', 'Role', 'Branch'],
    query: `
      select
        u.id as "id",
        u.name as "Name",
        u.email as "Email",
        r.name as "Role",
        coalesce(b.name, 'Unassigned') as "Branch",
        u.status as "Status",
        u.role_id as "roleId",
        coalesce(u.branch_id::text, '') as "branchId",
        (case when r.is_system = 1 then u.is_cross_branch else 0 end)::text as "isCrossBranch"
      from users u
      join roles r on r.id = u.role_id
      left join branches b on b.id = u.branch_id
      where u.deleted_at is null
      order by u.created_at desc
    `,
  },
  branches: {
    permission: 'branches.read',
    branchFilter: 'id = $1',
    searchFields: ['Branch', 'Code', 'Manager', 'Phone'],
    query: `
      select
        id::text as "id",
        name as "Branch",
        code as "Code",
        coalesce(manager_name, 'Unassigned') as "Manager",
        coalesce(phone, '—') as "Phone",
        status as "Status"
      from branches
      where deleted_at is null
      order by name
    `,
  },
  employees: {
    permission: 'employees.read',
    branchFilter: 'e.branch_id = $1',
    searchFields: ['Name', 'Employee ID', 'Position', 'Branch', 'Phone'],
    sortExpressions: { 'Hire date': '"hiredAt"' },
    query: `
      select
        e.id::text as "id",
        e.name as "Name",
        e.employee_number as "Employee ID",
        e.position as "Position",
        b.name as "Branch",
        e.branch_id::text as "branchId",
        coalesce(e.email, '') as "email",
        coalesce(e.phone, '') as "phone",
        coalesce(e.phone, '—') as "Phone",
        e.hired_at as "hiredAt",
        coalesce(to_char(e.hired_at at time zone 'UTC', 'Mon DD, YYYY'), '—') as "Hire date",
        e.status as "Status"
      from employees e
      join branches b on b.id = e.branch_id
      where e.deleted_at is null
      order by e.name
    `,
  },
  customers: {
    permission: 'customers.read',
    branchFilter: 'c.branch_id = $1',
    unassignedBranchFilter: 'c.branch_id is null',
    searchFields: ['Customer', 'Contact', 'Email', 'Phone', 'Location', 'Branch'],
    query: `
      select
        c.id::text as "id",
        c.name as "Customer",
        coalesce(c.contact_name, '—') as "Contact",
        coalesce(c.email, '—') as "Email",
        coalesce(c.phone, '—') as "Phone",
        coalesce(c.location, '—') as "Location",
        coalesce(b.name, 'Unassigned') as "Branch",
        c.branch_id::text as "branchId",
        c.status as "Status"
      from customers c
      left join branches b on b.id = c.branch_id
      where c.deleted_at is null
      order by c.name
    `,
  },
  suppliers: {
    permission: 'suppliers.read',
    searchFields: ['Supplier', 'Contact', 'Category', 'Phone'],
    query: `
      select
        id::text as "id",
        name as "Supplier",
        coalesce(contact_name, '—') as "Contact",
        coalesce(phone, '—') as "Phone",
        coalesce(category, '—') as "Category",
        coalesce(payment_terms, '—') as "Payment terms",
        status as "Status"
      from suppliers
      where deleted_at is null
      order by name
    `,
  },
  products: {
    permission: 'products.read',
    searchFields: ['Product', 'SKU', 'Category', 'Unit'],
    sortExpressions: { 'Unit price': '"unitPrice"::numeric' },
    query: `
      select
        p.id::text as "id",
        p.name as "Product",
        p.sku as "SKU",
        p.category as "Category",
        p.unit as "Unit",
        p.unit_price::text as "unitPrice",
        '₱' || to_char(p.unit_price, 'FM999,999,999,990.00') as "Unit price",
        p.status as "Status"
      from products p
      where p.deleted_at is null
      order by p.name
    `,
  },
  inventory: {
    permission: 'inventory.read',
    branchFilter: 'i.branch_id = $1',
    searchFields: ['Product', 'SKU', 'Branch', 'Status'],
    sortExpressions: {
      'On hand': '"quantity"::numeric',
      Reserved: '"reservedQuantity"::numeric',
      Available: '"availableQuantity"::numeric',
      'Reorder point': '"reorderLevel"::numeric',
    },
    query: `
      select
        i.id::text as "id",
        i.product_id::text as "productId",
        i.branch_id::text as "branchId",
        i.quantity::text as "quantity",
        i.reserved_quantity::text as "reservedQuantity",
        (i.quantity - i.reserved_quantity)::text as "availableQuantity",
        i.reorder_level::text as "reorderLevel",
        p.name as "Product",
        p.sku as "SKU",
        b.name as "Branch",
        i.quantity || ' ' || p.unit as "On hand",
        i.reserved_quantity || ' ' || p.unit as "Reserved",
        (i.quantity - i.reserved_quantity) || ' ' || p.unit as "Available",
        i.reorder_level || ' ' || p.unit as "Reorder point",
        case
          when i.quantity = 0 then 'Out of stock'
          when i.quantity <= i.reorder_level then 'Low stock'
          else 'In stock'
        end as "Status"
      from inventory i
      join products p on p.id = i.product_id
      join branches b on b.id = i.branch_id
      order by b.name, p.name
    `,
  },
  transfers: {
    permission: 'inventory.transfer',
    branchFilter: '(t.from_branch_id = $1 or t.to_branch_id = $1)',
    searchFields: ['Transfer ID', 'From', 'To', 'Status'],
    query: `
      select
        t.id::text as "id",
        t.reference as "Transfer ID",
        f.name as "From",
        d.name as "To",
        count(ti.id)::text || ' item(s)' as "Items",
        to_char(t.created_at, 'Mon DD, YYYY') as "Requested",
        t.status as "Status"
      from inventory_transfers t
      join branches f on f.id = t.from_branch_id
      join branches d on d.id = t.to_branch_id
      left join inventory_transfer_items ti on ti.transfer_id = t.id
      group by t.id, f.name, d.name
      order by t.created_at desc
    `,
  },
  orders: {
    permission: 'sales.read',
    branchFilter: 'o.branch_id = $1',
    searchFields: ['Order', 'Customer', 'Branch', 'Status'],
    query: `
      select
        o.id::text as "id",
        o.order_number as "Order",
        c.name as "Customer",
        to_char(o.created_at, 'Mon DD, YYYY') as "Date",
        '₱' || to_char(${remainingOrderValueSql}, 'FM999,999,990.00') as "Amount",
        b.name as "Branch",
        o.status as "Status"
      from orders o
      join customers c on c.id = o.customer_id
      join branches b on b.id = o.branch_id
      order by o.created_at desc
    `,
  },
  payments: {
    permission: 'payments.read',
    branchFilter: 'financial.branch_id = $1',
    searchFields: ['Order', 'Customer', 'Status'],
    sortExpressions: {
      'Total Amount': '"totalAmount"::numeric',
      'Amount Paid': '"paidAmount"::numeric',
      'Remaining Balance': '"balanceAmount"::numeric',
      'Last Payment Date': '"lastPaymentDate"::date',
    },
    query: `
      select
        financial.id::text as "id",
        financial.order_number as "Order",
        c.name as "Customer",
        '₱' || to_char(financial.payable_amount, 'FM999,999,999,990.00') as "Total Amount",
        '₱' || to_char(financial.net_paid_amount, 'FM999,999,999,990.00') as "Amount Paid",
        case when financial.balance < 0 then '-' else '' end || '₱' ||
          to_char(abs(financial.balance), 'FM999,999,999,990.00') as "Remaining Balance",
        ${paymentStatusSql} as "Status",
        coalesce(to_char(financial.last_payment_date, 'Mon DD, YYYY'), '—') as "Last Payment Date",
        financial.payable_amount::text as "totalAmount",
        financial.net_paid_amount::text as "paidAmount",
        financial.balance::text as "balanceAmount",
        financial.last_payment_date::text as "lastPaymentDate"
      from (${orderPaymentAmountsSql}) financial
      join customers c on c.id = financial.customer_id
      order by financial.created_at desc
    `,
  },
  deliveries: {
    permission: 'deliveries.read',
    branchFilter: 'o.branch_id = $1',
    searchFields: ['Delivery', 'Order', 'Destination', 'Driver', 'Status'],
    query: `
      select
        d.id::text as "id",
        d.reference as "Delivery",
        o.order_number as "Order",
        d.destination as "Destination",
        coalesce(d.driver_name, 'Unassigned') as "Driver",
        coalesce(to_char(d.scheduled_at, 'Mon DD, YYYY HH12:MI AM'), 'Unscheduled') as "Schedule",
        d.status as "Status"
      from deliveries d
      join orders o on o.id = d.order_id
      order by d.created_at desc
    `,
  },
  expenses: {
    permission: 'expenses.read',
    branchFilter: 'e.branch_id = $1',
    searchFields: ['Expense', 'Category', 'Branch', 'Submitted by', 'Status'],
    sortExpressions: { Amount: '"amount"::numeric', Date: '"createdAt"::timestamptz' },
    query: `
      select
        e.id::text as "id",
        e.amount::text as "amount",
        e.branch_id::text as "branchId",
        e.created_at as "createdAt",
        e.description as "Expense",
        e.category as "Category",
        b.name as "Branch",
        u.name as "Submitted by",
        to_char(e.created_at, 'Mon DD, YYYY') as "Date",
        '₱' || to_char(e.amount, 'FM999,999,999,990.00') as "Amount",
        e.status as "Status"
      from expenses e
      join branches b on b.id = e.branch_id
      join users u on u.id = e.submitted_by
      order by e.created_at desc
    `,
  },
  payroll: {
    permission: 'payroll.read',
    branchFilter: 'p.branch_id = $1',
    searchFields: ['Pay run', 'Period', 'Branch', 'Status'],
    sortExpressions: {
      Period: 'p.period_start',
      Employees: 'p.employee_count',
      'Gross pay': 'p.gross_pay::numeric',
      'Net pay': 'pay_totals.net_pay',
      Status: 'p.status',
    },
    query: `
      select
        p.id::text as "id",
        p.reference as "Pay run",
        to_char(p.period_start, 'Mon DD') || '–' || to_char(p.period_end, 'DD, YYYY') as "Period",
        p.employee_count::text as "Employees",
        '₱' || to_char(p.gross_pay, 'FM999,999,990.00') as "Gross pay",
        '₱' || to_char(pay_totals.net_pay, 'FM999,999,990.00') as "Net pay",
        pay_totals.paid_count::text || ' / ' || p.employee_count::text as "Paid",
        coalesce(b.name, 'All branches') as "Branch",
        p.status as "Status"
      from payroll_runs p
      left join branches b on b.id = p.branch_id
      left join lateral (
        select
          coalesce(sum(e.net_pay), 0)::numeric as net_pay,
          count(*) filter (where e.payment_status in ('Paid', 'Received'))::int as paid_count
        from payroll_entries e where e.payroll_run_id = p.id
      ) pay_totals on true
      order by p.period_start desc
    `,
  },
  reports: {
    permission: 'reports.view',
    searchFields: ['Report', 'Category', 'Period', 'Status'],
    query: `
      select
        report as "Report",
        category as "Category",
        'Choose dates' as "Period",
        'On demand' as "Last generated",
        'System' as "Owner",
        'Ready to generate' as "Status"
      from (values
        ('Completed sales by branch', 'Sales'),
        ('Approved expenses by category', 'Finance'),
        ('Current inventory health by branch', 'Inventory')
      ) as report_catalog(report, category)
      order by category, report
    `,
  },
  'audit-logs': {
    permission: 'audit.read',
    branchFilter: 'a.branch_id = $1',
    searchFields: ['Action', 'User', 'Module', 'Branch'],
    query: `
      select
        a.action as "Action",
        u.name as "User",
        a.entity_type as "Module",
        coalesce(b.name, 'All branches') as "Branch",
        to_char(a.created_at, 'Mon DD, YYYY HH12:MI AM') as "Date & time"
      from audit_logs a
      join users u on u.id = a.user_id
      left join branches b on b.id = a.branch_id
      order by a.created_at desc
    `,
  },
}
