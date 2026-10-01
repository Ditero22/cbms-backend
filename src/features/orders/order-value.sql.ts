// These queries use the internal `o` order alias. Keep contractual value separate
// from net collections: refunds change payments, cancellation changes line value.
export const remainingOrderValueSql = `coalesce((select sum(
  oi.line_total - round(oi.unit_price * oi.cancelled_quantity, 2))
  from order_items oi where oi.order_id = o.id), 0)`
