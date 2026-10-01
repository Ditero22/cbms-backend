import { describe, expect, it } from 'vitest'
import { formatMoneyCents, moneyToCents } from '@/features/orders/order.money.js'

describe('signed financial balances', () => {
  it.each([
    ['-0.01', -1n],
    ['-0.99', -99n],
    ['-1.01', -101n],
    ['-1000.50', -100050n],
    ['0.00', 0n],
    ['999999999999.99', 99999999999999n],
  ] as const)('round-trips %s without losing its sign or cents', (amount, cents) => {
    expect(moneyToCents(amount)).toBe(cents)
    expect(formatMoneyCents(cents)).toBe(amount)
  })
})
