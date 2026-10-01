import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { pool } from '@/database/client.js'
import { getDashboardSummary } from '@/features/dashboard/dashboard.service.js'
import { generateReport } from '@/features/reports/reports.service.js'
import { reportToCsv } from '@/features/reports/reports.csv.js'
import { listModuleRecords } from '@/features/records/record.service.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

async function insertId(query: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(query, values)
  const id = result.rows[0]?.id
  if (!id) throw new Error('The financial report fixture could not be created.')
  return id
}

afterAll(async () => {
  await pool.end()
})

describe('financial reporting definitions', () => {
  it('separates remaining order value from net collections across cancellation, refund, and branches', async () => {
    const fixture = randomUUID().slice(0, 8)
    const northName = `Financial North ${fixture}`
    const southName = `Financial South ${fixture}`
    const roleId = await insertId('insert into roles (name) values ($1) returning id', [
      `Financial reporter ${fixture}`,
    ])
    const northId = await insertId(
      'insert into branches (name, code) values ($1, $2) returning id',
      [northName, `fn-${fixture}`],
    )
    const southId = await insertId(
      'insert into branches (name, code) values ($1, $2) returning id',
      [southName, `fs-${fixture}`],
    )
    const userId = await insertId(
      `insert into users (email, name, password_hash, role_id, branch_id, status)
       values ($1, $2, 'unused-test-hash', $3, $4, 'Active') returning id`,
      [`financial-${fixture}@example.invalid`, 'Financial test actor', roleId, northId],
    )
    const customerId = await insertId(
      'insert into customers (name, branch_id) values ($1, $2) returning id',
      [`Financial customer ${fixture}`, northId],
    )
    const productId = await insertId(
      `insert into products (name, sku, category, unit, unit_price)
       values ($1, $2, 'Materials', 'piece', '10.00') returning id`,
      [`Financial product ${fixture}`, `FIN-${fixture}`],
    )
    let sequence = 0
    async function makeOrder(
      branchId: string,
      quantity: number,
      cancelled: number,
      status: string,
    ) {
      sequence += 1
      const orderNumber = `FIN-${fixture}-${sequence}`
      const orderId = await insertId(
        `insert into orders (order_number, customer_id, branch_id, total_amount, status, created_by)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [orderNumber, customerId, branchId, `${quantity * 10}.00`, status, userId],
      )
      await pool.query(
        `insert into order_items
          (order_id, product_id, quantity, cancelled_quantity, unit_price, line_total)
         values ($1, $2, $3, $4, '10.00', $5)`,
        [orderId, productId, quantity, cancelled, `${quantity * 10}.00`],
      )
      const paymentId = await insertId(
        `insert into payments (reference, order_id, method, amount, status, recorded_by)
         values ($1, $2, 'Cash', $3, 'Paid', $4) returning id`,
        [`FIN-PAY-${fixture}-${sequence}`, orderId, `${quantity * 10}.00`, userId],
      )
      return { orderId, orderNumber, paymentId }
    }
    async function addRefund(
      orderId: string,
      paymentId: string,
      amount: string,
      status: 'Requested' | 'Processed',
    ) {
      sequence += 1
      return insertId(
        `insert into payment_refunds
          (reference, request_key, order_id, payment_id, amount, method, reason,
           status, requested_by, processed_by, processed_at)
         values ($1, $2, $3, $4, $5, 'Cash', 'Order adjustment', $6, $7,
                 case when $6 = 'Processed' then $7::uuid else null end,
                 case when $6 = 'Processed' then now() else null end)
         returning id`,
        [
          `FIN-REF-${fixture}-${sequence}`,
          randomUUID(),
          orderId,
          paymentId,
          amount,
          status,
          userId,
        ],
      )
    }

    // Remaining contract: ₱20 order less one cancelled ₱10 line = ₱10.
    // Net collected: ₱20 paid less ₱10 processed refund = ₱10.
    const partial = await makeOrder(northId, 2, 1, 'Completed')
    await addRefund(partial.orderId, partial.paymentId, '10.00', 'Processed')
    const full = await makeOrder(northId, 2, 2, 'Cancelled')
    await addRefund(full.orderId, full.paymentId, '20.00', 'Processed')
    const laterRefund = await makeOrder(northId, 2, 0, 'Completed')
    const pendingRefundId = await addRefund(
      laterRefund.orderId,
      laterRefund.paymentId,
      '5.00',
      'Requested',
    )
    await makeOrder(southId, 3, 0, 'Completed')

    const northUser: AuthenticatedUser = {
      id: userId,
      name: 'Financial test actor',
      email: `financial-${fixture}@example.invalid`,
      role: `Financial reporter ${fixture}`,
      branchId: northId,
      branch: northName,
      isCrossBranch: false,
      permissions: ['sales.read', 'reports.view'],
    }
    const southUser = { ...northUser, branchId: southId, branch: southName }
    const year = new Date().getUTCFullYear()
    const reportQuery = {
      report: 'sales-by-branch' as const,
      dateFrom: `${year}-01-01`,
      dateTo: `${year}-12-31`,
    }

    const dashboard = await getDashboardSummary(northUser)
    const orderList = await listModuleRecords('orders', northUser, { search: `FIN-${fixture}` })
    expect(Object.fromEntries(orderList.data.map((order) => [order.Order, order.Amount]))).toEqual({
      [partial.orderNumber]: '₱10.00',
      [full.orderNumber]: '₱0.00',
      [laterRefund.orderNumber]: '₱20.00',
    })
    expect(dashboard.stats.salesTotal).toBe('30.00')
    expect(dashboard.stats.openOrders).toBe(0)
    expect(dashboard.branchSales).toEqual([{ name: northName, total: '30.00' }])
    expect(
      Object.fromEntries(dashboard.recentOrders.map((order) => [order.Order, order.Amount])),
    ).toMatchObject({
      [partial.orderNumber]: '₱10.00',
      [full.orderNumber]: '₱0.00',
      [laterRefund.orderNumber]: '₱20.00',
    })
    const southDashboard = await getDashboardSummary(southUser)
    expect(southDashboard.stats.salesTotal).toBe('30.00')
    expect(southDashboard.branchSales).toEqual([{ name: southName, total: '30.00' }])
    expect(southDashboard.recentOrders).toHaveLength(1)

    const initial = await generateReport(reportQuery, northUser)
    expect(initial.columns).toEqual([
      'Branch',
      'Completed orders',
      'Sales (PHP)',
      'Payments (PHP)',
      'Refunds (PHP)',
      'Net collected (PHP)',
    ])
    expect(initial.rows).toMatchObject([
      {
        Branch: northName,
        'Completed orders': '2',
        'Sales (PHP)': '30.00',
        'Payments (PHP)': '40.00',
        'Refunds (PHP)': '10.00',
        'Net collected (PHP)': '30.00',
      },
    ])
    expect(reportToCsv(initial)).toContain('"Net collected (PHP)"')
    const southReport = await generateReport(reportQuery, southUser)
    expect(southReport.rows).toMatchObject([
      {
        Branch: southName,
        'Completed orders': '1',
        'Sales (PHP)': '30.00',
        'Payments (PHP)': '30.00',
        'Refunds (PHP)': '0',
        'Net collected (PHP)': '30.00',
      },
    ])

    // A processed refund after completion changes collections, not the contract.
    await pool.query(
      `update payment_refunds
       set status = 'Processed', processed_by = $2, processed_at = now() where id = $1`,
      [pendingRefundId, userId],
    )
    const updated = await generateReport(reportQuery, northUser)
    expect(updated.rows).toMatchObject([
      {
        'Sales (PHP)': '30.00',
        'Payments (PHP)': '40.00',
        'Refunds (PHP)': '15.00',
        'Net collected (PHP)': '25.00',
      },
    ])
    const stableDashboard = await getDashboardSummary(northUser)
    expect(stableDashboard.stats.salesTotal).toBe('30.00')
    expect(stableDashboard.branchSales).toEqual([{ name: northName, total: '30.00' }])
    expect(
      stableDashboard.recentOrders.find((order) => order.Order === full.orderNumber)?.Amount,
    ).toBe('₱0.00')
  })
})
