import { describe, expect, it } from 'vitest'
import {
  inventoryAdjustmentSchema,
  inventoryDetailQuerySchema,
  inventoryReorderSchema,
} from '@/features/inventory/inventory.schemas.js'

const target = {
  productId: '00000000-0000-4000-8000-000000000001',
  branchId: '00000000-0000-4000-8000-000000000002',
}

describe('inventory quantity validation', () => {
  it('preserves signed exact thousandths and accepts legacy JSON numbers', () => {
    expect(
      inventoryAdjustmentSchema.parse({ ...target, quantityDelta: '-0002.375' }).quantityDelta,
    ).toBe('-2.375')
    expect(inventoryAdjustmentSchema.parse({ ...target, quantityDelta: 0.125 }).quantityDelta).toBe(
      '0.125',
    )
    expect(
      inventoryAdjustmentSchema.parse({ ...target, quantityDelta: '1000000' }).quantityDelta,
    ).toBe('1000000.000')
  })
  it('rejects rounding, exponent text, empty/zero quantities and excessive adjustments', () => {
    for (const quantityDelta of ['1.0001', '1e3', '', 0, '-0.000', '1000000.001', true, null]) {
      expect(inventoryAdjustmentSchema.safeParse({ ...target, quantityDelta }).success).toBe(false)
    }
  })
  it('supports disabling a reorder point while rejecting negatives, precision and unexpected stock fields', () => {
    expect(inventoryReorderSchema.parse({ reorderLevel: '0' }).reorderLevel).toBe('0.000')
    expect(inventoryReorderSchema.parse({ reorderLevel: 10.375 }).reorderLevel).toBe('10.375')
    for (const reorderLevel of ['-1', '1.0001', '1000000.001', null]) {
      expect(inventoryReorderSchema.safeParse({ reorderLevel }).success).toBe(false)
    }
    expect(inventoryReorderSchema.safeParse({ reorderLevel: 1, quantity: 999 }).success).toBe(false)
  })
  it('validates optional idempotency keys and strict adjustment inputs', () => {
    expect(
      inventoryAdjustmentSchema.parse({
        ...target,
        quantityDelta: '0.125',
        requestKey: 'ABCDEF00-0000-4000-8000-000000000003',
      }).requestKey,
    ).toBe('abcdef00-0000-4000-8000-000000000003')
    expect(
      inventoryAdjustmentSchema.safeParse({
        ...target,
        quantityDelta: 1,
        requestKey: 'unsafe-retry',
      }).success,
    ).toBe(false)
    expect(
      inventoryAdjustmentSchema.safeParse({ ...target, quantityDelta: 1, reservedQuantity: 0 })
        .success,
    ).toBe(false)
  })
})

describe('inventory history filters', () => {
  it('accepts independent business-date bounds with bounded pagination', () => {
    expect(
      inventoryDetailQuerySchema.parse({ dateFrom: '2026-10-01', movementPage: '2' }),
    ).toMatchObject({ movementPage: 2, historyPage: 1, movementType: '' })
    expect(inventoryDetailQuerySchema.safeParse({ dateTo: '2026-10-01' }).success).toBe(true)
  })
  it('rejects invalid dates, reversed ranges, zero/fractional pages and unknown query parameters', () => {
    for (const query of [
      { dateFrom: '2026-02-30' },
      { dateFrom: '2026-10-02', dateTo: '2026-10-01' },
      { movementPage: 0 },
      { historyPage: 1.5 },
      { quantity: 3 },
    ]) {
      expect(inventoryDetailQuerySchema.safeParse(query).success).toBe(false)
    }
  })
})
