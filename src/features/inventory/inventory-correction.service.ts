import { withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { formatQuantityMilli, quantityToMilli } from '@/features/orders/order.money.js'
import { findInventoryRecord } from './inventory-detail.repository.js'
import {
  findActiveStockTarget,
  lockAdjustmentRequest,
  updateStockQuantity,
} from './inventory.repository.js'
import {
  findCorrectionRequest,
  findLatestMovement,
  insertCorrection,
  isCorrectableAddition,
} from './inventory-correction.repository.js'
import { inventoryCorrectionSchema, type InventoryCorrectionInput } from './inventory.schemas.js'

export async function correctLatestStockAddition(
  inventoryId: string,
  values: InventoryCorrectionInput,
  user: AuthenticatedUser,
  context: { ipAddress: string | null; requestId: string | null },
) {
  if (
    !user.permissions.includes('inventory.read') ||
    !user.permissions.includes('inventory.adjust')
  ) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to correct stock.')
  }
  const branchScope = getAssignedBranchScope(user)
  const parsed = inventoryCorrectionSchema.safeParse(values)
  if (!parsed.success)
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Check the stock correction.',
      parsed.error.flatten(),
    )
  const input = parsed.data
  return withTransaction(async (client) => {
    // Shared with ordinary adjustment keys so reuse cannot cross command types.
    await lockAdjustmentRequest(client, input.requestKey)
    const inventory = await findInventoryRecord(client, inventoryId, branchScope, true)
    if (!inventory) throw new AppError(404, 'INVENTORY_NOT_FOUND', 'Inventory record not found.')
    const existing = await findCorrectionRequest(client, input.requestKey)
    if (existing) {
      const same =
        existing.transactionType === 'Correction' &&
        existing.referenceType === 'StockCorrection' &&
        existing.productId === inventory.productId &&
        existing.branchId === inventory.branchId &&
        existing.performedBy === user.id &&
        existing.referenceId === input.transactionId &&
        existing.note === input.reason &&
        existing.originalQuantity !== null &&
        quantityToMilli(existing.originalQuantity) + quantityToMilli(existing.quantityDelta) ===
          quantityToMilli(input.correctedQuantity)
      if (!same)
        throw new AppError(
          409,
          'REQUEST_KEY_CONFLICT',
          'This stock correction request was already used with different values.',
        )
      return { id: existing.id, quantity: inventory.quantity }
    }
    if (!(await findActiveStockTarget(client, inventory.productId, inventory.branchId))) {
      throw new AppError(
        409,
        'STOCK_TARGET_INACTIVE',
        'Stock corrections require an active product and branch.',
      )
    }
    const latest = await findLatestMovement(client, inventory)
    if (!isCorrectableAddition(latest) || latest?.id !== input.transactionId) {
      throw new AppError(
        409,
        'STOCK_CORRECTION_STALE',
        'Only the latest manual stock addition can be corrected. Refresh the record or use a stock adjustment for an older mistake.',
      )
    }
    const delta = quantityToMilli(input.correctedQuantity) - quantityToMilli(latest.quantityDelta)
    if (delta === 0n)
      throw new AppError(
        400,
        'STOCK_CORRECTION_UNCHANGED',
        'Enter a quantity different from the original addition.',
      )
    const stock = await updateStockQuantity(
      client,
      inventory.productId,
      inventory.branchId,
      formatQuantityMilli(delta),
    )
    if (!stock)
      throw new AppError(
        409,
        'STOCK_CORRECTION_LIMIT',
        'The correction must leave enough stock for reservations and stay within the stock quantity limit.',
      )
    return insertCorrection(client, inventory, {
      ...input,
      originalQuantity: latest.quantityDelta,
      quantityDelta: formatQuantityMilli(delta),
      quantity: stock.quantity,
      userId: user.id,
      ...context,
    })
  })
}
