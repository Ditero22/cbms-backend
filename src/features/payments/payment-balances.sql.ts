import { remainingOrderValueSql } from '@/features/orders/order-value.sql.js'

// Order cancellation changes contractual value; refunds change collections.
// Physical returns do not independently reverse either financial total.
export const orderPaymentAmountsSql = `
  select o.id, o.order_number, o.customer_id, o.branch_id, o.status,
         o.created_at, o.total_amount as original_total,
         ${remainingOrderValueSql} as payable_amount,
         coalesce(paid.amount, 0) as payments_amount,
         coalesce(refunded.processed, 0) as refunded_amount,
         coalesce(refunded.pending, 0) as pending_refund_amount,
         coalesce(paid.amount, 0) - coalesce(refunded.processed, 0) as net_paid_amount,
         ${remainingOrderValueSql} - coalesce(paid.amount, 0) + coalesce(refunded.processed, 0) as balance,
         paid.last_payment_date
    from orders o
    left join lateral (
      select sum(p.amount) as amount, max(p.payment_date) as last_payment_date
        from payments p where p.order_id = o.id and p.status = 'Paid'
    ) paid on true
    left join lateral (
      select sum(r.amount) filter (where r.status = 'Processed') as processed,
             sum(r.amount) filter (where r.status in ('Requested', 'Approved')) as pending
        from payment_refunds r where r.order_id = o.id
    ) refunded on true
`

// Keep signed legacy overpayments visible rather than reporting a paid balance.
export const paymentStatusSql = `case
  when financial.status = 'Cancelled' then 'Cancelled'
  when financial.balance < 0 then 'Overpaid'
  when financial.balance = 0 then 'Paid'
  when financial.net_paid_amount > 0 then 'Partially Paid'
  else 'Unpaid' end`
