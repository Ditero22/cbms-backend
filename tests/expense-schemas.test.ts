import { describe, expect, it } from 'vitest'
import { expenseReviewSchema } from '../src/features/expenses/expense.schemas.js'

describe('expenseReviewSchema', () => {
  it('accepts an approval with no note', () => {
    expect(expenseReviewSchema.safeParse({ decision: 'Approved' }).success).toBe(true)
  })

  it('accepts a rejection with a reason', () => {
    expect(
      expenseReviewSchema.safeParse({ decision: 'Rejected', note: 'Receipt is missing' }).success,
    ).toBe(true)
  })

  it('requires a non-empty reason for rejection', () => {
    expect(expenseReviewSchema.safeParse({ decision: 'Rejected', note: '   ' }).success).toBe(false)
  })

  it('rejects notes longer than 500 characters', () => {
    expect(
      expenseReviewSchema.safeParse({ decision: 'Approved', note: 'x'.repeat(501) }).success,
    ).toBe(false)
  })
})
