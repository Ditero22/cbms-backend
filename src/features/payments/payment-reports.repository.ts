import { pool } from '@/database/client.js'
import type { ReportResult } from '@/features/reports/reports.repository.js'
import { orderPaymentAmountsSql, paymentStatusSql } from './payment-balances.sql.js'

export type CustomerPaymentReportInput = {
  report: 'customer-balances' | 'customer-payment-history'
  dateFrom: string
  dateTo: string
  customerId?: string | undefined
  status?: string | undefined
}

export async function queryCustomerPaymentReport(
  input: CustomerPaymentReportInput,
  branchId?: string,
): Promise<ReportResult> {
  const snapshot = input.report === 'customer-balances'
  const title = snapshot ? 'Current customer balances' : 'Customer payment receipt history'
  const columns = snapshot
    ? [
        'Order',
        'Customer',
        'Branch',
        'Total (PHP)',
        'Paid (PHP)',
        'Refunded (PHP)',
        'Net paid (PHP)',
        'Balance (PHP)',
        'Status',
        'Last payment date',
      ]
    : [
        'Order',
        'Customer',
        'Branch',
        'Receipt',
        'Payment date',
        'Method',
        'Amount (PHP)',
        'External reference',
        'Recorded by',
        'Notes',
      ]
  const commonScope = `($3::uuid is null or financial.branch_id = $3)
    and ($4::uuid is null or financial.customer_id = $4)
    and ($5::text is null or ${paymentStatusSql} = $5)`
  const query = snapshot
    ? `select financial.order_number as "Order", c.name as "Customer", b.name as "Branch",
              financial.payable_amount::text as "Total (PHP)",
              financial.payments_amount::text as "Paid (PHP)",
              financial.refunded_amount::text as "Refunded (PHP)",
              financial.net_paid_amount::text as "Net paid (PHP)",
              financial.balance::text as "Balance (PHP)", ${paymentStatusSql} as "Status",
              coalesce(financial.last_payment_date::text, '—') as "Last payment date"
         from (${orderPaymentAmountsSql}) financial
         join customers c on c.id = financial.customer_id
         join branches b on b.id = financial.branch_id
        where ${commonScope} and $1::date is not null and $2::date is not null
        order by financial.balance desc, financial.order_number`
    : `select financial.order_number as "Order", c.name as "Customer", b.name as "Branch",
              p.reference as "Receipt", p.payment_date::text as "Payment date", p.method as "Method",
              p.amount::text as "Amount (PHP)", coalesce(p.external_reference, '—') as "External reference",
              u.name as "Recorded by", coalesce(p.notes, '—') as "Notes"
         from payments p
         join (${orderPaymentAmountsSql}) financial on financial.id = p.order_id
         join customers c on c.id = financial.customer_id
         join branches b on b.id = financial.branch_id
         join users u on u.id = p.recorded_by
        where ${commonScope} and p.status = 'Paid'
          and p.payment_date between $1::date and $2::date
        order by p.payment_date desc, p.created_at desc, p.id desc`
  const result = await pool.query<Record<string, string>>(query, [
    input.dateFrom,
    input.dateTo,
    branchId ?? null,
    input.customerId ?? null,
    input.status ?? null,
  ])
  return {
    title,
    columns,
    rows: result.rows,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    generatedAt: new Date().toISOString(),
  }
}
