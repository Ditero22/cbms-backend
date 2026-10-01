import { describe, expect, it } from 'vitest'
import { addBranchFilter } from '@/features/records/query-scope.js'
import { models } from '@/features/records/record-models.js'

describe('branch-scoped query construction', () => {
  it('adds a branch filter to an existing WHERE clause before ordering', () => {
    const query = 'select * from users where deleted_at is null order by created_at desc'

    expect(addBranchFilter(query, 'branch_id = $1')).toBe(
      'select * from users where deleted_at is null and branch_id = $1 order by created_at desc',
    )
  })

  it('adds the first WHERE clause before grouping', () => {
    const query = 'select branch_id, count(*) from orders group by branch_id order by branch_id'

    expect(addBranchFilter(query, 'branch_id = $1')).toBe(
      'select branch_id, count(*) from orders where branch_id = $1 group by branch_id order by branch_id',
    )
  })

  it('applies branch scoping to customer payment balances through their order', () => {
    expect(models.payments?.branchFilter).toBe('financial.branch_id = $1')
    expect(
      addBranchFilter(models.payments?.query ?? '', models.payments?.branchFilter ?? ''),
    ).toContain('where financial.branch_id = $1')
  })

  it('ignores nested filters, grouping, ordering, and quoted clause names', () => {
    const query = `select 'where order by' as label,
      (select sum(amount) from payments where order_id = o.id group by order_id order by order_id)
      from orders o order by o.created_at`
    expect(addBranchFilter(query, 'o.branch_id = $1')).toBe(
      query.replace(' order by o.created_at', ' where o.branch_id = $1 order by o.created_at'),
    )
  })
})
