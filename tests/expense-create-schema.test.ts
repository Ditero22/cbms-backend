import { describe, expect, it } from 'vitest'
import {
  expenseCreateSchema,
  expenseDetailQuerySchema,
} from '@/features/expenses/expense.schemas.js'

const expense = { description: 'Concrete delivery supplies', category: 'Site supplies' }

describe('manual expense validation', () => {
  it('retains exact cents and accepts valid legacy JSON amounts without rounding', () => {
    expect(expenseCreateSchema.parse({ ...expense, amount: '000125.25' }).amount).toBe('125.25')
    expect(expenseCreateSchema.parse({ ...expense, amount: 0.01 }).amount).toBe('0.01')
    expect(expenseCreateSchema.parse({ ...expense, amount: '999999999999.99' }).amount).toBe(
      '999999999999.99',
    )
  })
  it('rejects extra precision, exponent strings, nonnumeric values and out-of-range amounts', () => {
    for (const amount of [
      '1.001',
      '1e2',
      '-1',
      '0',
      '999999999999.999',
      '1000000000000',
      null,
      true,
      '',
    ])
      expect(expenseCreateSchema.safeParse({ ...expense, amount }).success).toBe(false)
  })
  it('normalizes retry keys and descriptions but rejects forged status/actor/source fields', () => {
    expect(
      expenseCreateSchema.parse({
        ...expense,
        description: '  Site supplies  ',
        amount: '125',
        requestKey: 'ABCDEF00-0000-4000-8000-000000000003',
      }),
    ).toMatchObject({
      description: 'Site supplies',
      amount: '125.00',
      requestKey: 'abcdef00-0000-4000-8000-000000000003',
    })
    for (const forged of [
      { status: 'Approved' },
      { submittedBy: '00000000-0000-4000-8000-000000000001' },
      { expenseId: '00000000-0000-4000-8000-000000000002' },
      { requestKey: 'arbitrary' },
    ])
      expect(expenseCreateSchema.safeParse({ ...expense, amount: '125', ...forged }).success).toBe(
        false,
      )
  })
  it('allows existing custom categories while enforcing readable field lengths', () => {
    expect(
      expenseCreateSchema.safeParse({
        ...expense,
        category: 'Custom permitted category',
        amount: '125.25',
      }).success,
    ).toBe(true)
    expect(
      expenseCreateSchema.safeParse({ ...expense, description: ' ', amount: '125.25' }).success,
    ).toBe(false)
    expect(
      expenseCreateSchema.safeParse({ ...expense, category: 'x'.repeat(121), amount: '125.25' })
        .success,
    ).toBe(false)
  })
  it('defaults and validates independently paginated audit history', () => {
    expect(expenseDetailQuerySchema.parse({})).toEqual({ historyPage: 1 })
    expect(expenseDetailQuerySchema.parse({ historyPage: '2' })).toEqual({ historyPage: 2 })
    for (const query of [
      { historyPage: 0 },
      { historyPage: 1.5 },
      { historyPage: 100001 },
      { limit: 500 },
    ])
      expect(expenseDetailQuerySchema.safeParse(query).success).toBe(false)
  })
})
