import { describe, expect, it } from 'vitest'
import { inventoryTransferSchema } from '@/features/inventory/inventory.schemas.js'

const sourceBranchId = '00000000-0000-4000-8000-000000000001'
const destinationBranchId = '00000000-0000-4000-8000-000000000002'
const productId = '00000000-0000-4000-8000-000000000003'

describe('inventory transfer validation', () => {
  it('accepts a transfer with distinct branches and positive fractional quantities', () => {
    const result = inventoryTransferSchema.safeParse({
      fromBranchId: sourceBranchId,
      toBranchId: destinationBranchId,
      items: [{ productId, quantity: '2.375' }],
      note: 'Restock the north branch',
    })

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.items[0]?.quantity).toBe('2.375')
  })

  it('rejects transfers to the same branch', () => {
    const result = inventoryTransferSchema.safeParse({
      fromBranchId: sourceBranchId,
      toBranchId: sourceBranchId,
      items: [{ productId, quantity: 1 }],
    })

    expect(result.success).toBe(false)
  })

  it('rejects duplicate product lines and quantities beyond inventory precision', () => {
    const result = inventoryTransferSchema.safeParse({
      fromBranchId: sourceBranchId,
      toBranchId: destinationBranchId,
      items: [
        { productId, quantity: 1 },
        { productId, quantity: 2 },
      ],
    })

    expect(result.success).toBe(false)

    const impreciseQuantity = inventoryTransferSchema.safeParse({
      fromBranchId: sourceBranchId,
      toBranchId: destinationBranchId,
      items: [{ productId, quantity: 1.0001 }],
    })

    expect(impreciseQuantity.success).toBe(false)
  })

  it('accepts optional UUID replay keys and normalizes equivalent decimal input', () => {
    const requestKey = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    const result = inventoryTransferSchema.safeParse({
      fromBranchId: sourceBranchId,
      toBranchId: destinationBranchId,
      items: [{ productId, quantity: '0002.5' }],
      requestKey,
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requestKey).toBe(requestKey.toLowerCase())
      expect(result.data.items[0]?.quantity).toBe('2.500')
    }
    expect(
      inventoryTransferSchema.safeParse({
        fromBranchId: sourceBranchId,
        toBranchId: destinationBranchId,
        items: [{ productId, quantity: 2.5 }],
        requestKey: 'not-a-uuid',
      }).success,
    ).toBe(false)
  })

  it('rejects coercible non-decimals, zero and excessive transfer quantities', () => {
    for (const quantity of ['', ' ', null, true, '1e2', '0', '-1', '1.0001', '1000000.001']) {
      expect(
        inventoryTransferSchema.safeParse({
          fromBranchId: sourceBranchId,
          toBranchId: destinationBranchId,
          items: [{ productId, quantity }],
        }).success,
      ).toBe(false)
    }
  })
})
