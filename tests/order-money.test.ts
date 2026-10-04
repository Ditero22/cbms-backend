import { describe, expect, it } from 'vitest'
import {
  formatMoneyCents,
  moneyToCents,
  formatQuantityMilli,
  quantityToMilli,
} from '@/shared/domain/fixed-point.js'

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

describe('shared fixed-point quantities', () => {
  it.each([
    ['-0.001', -1n],
    ['-12.345', -12345n],
    ['0.000', 0n],
    ['1.001', 1001n],
    ['999999999999.999', 999999999999999n],
  ] as const)('round-trips %s without floating-point arithmetic', (quantity, milli) => {
    expect(quantityToMilli(quantity)).toBe(milli)
    expect(formatQuantityMilli(milli)).toBe(quantity)
  })

  it('normalizes schema-validated number and short decimal inputs', () => {
    expect(formatQuantityMilli(quantityToMilli(2.375))).toBe('2.375')
    expect(formatQuantityMilli(quantityToMilli(' 2.5 '))).toBe('2.500')
    expect(formatMoneyCents(moneyToCents(' 2.5 '))).toBe('2.50')
  })
})
