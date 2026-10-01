import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import type { InventoryTransferInput } from './inventory.schemas.js'
import * as inventoryRepository from './inventory.repository.js'
import * as detailRepository from './inventory-detail.repository.js'
import {
  inventoryAdjustmentSchema,
  type InventoryDetailQuery,
  type InventoryReorderInput,
} from './inventory.schemas.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import { findLatestMovement, isCorrectableAddition } from './inventory-correction.repository.js'

type InventoryAdjustmentInput = {
  productId: string
  branchId: string
  quantityDelta: string | number
  note?: string | undefined
  requestKey?: string | undefined
}

type InventoryRequestContext = {
  userId: string
  ipAddress: string | null
  requestId: string | null
}

export function getInventoryFormOptions(branchId?: string | null) {
  return inventoryRepository.getInventoryOptions(branchId)
}

export function getInventoryTransferFormOptions() {
  return inventoryRepository.getInventoryTransferOptions()
}

function requireInventoryRead(user: AuthenticatedUser) {
  if (!user.permissions.includes('inventory.read')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view inventory.')
  }
  return getAssignedBranchScope(user)
}

export async function getInventoryTransferDetail(
  id: string,
  user: AuthenticatedUser,
  historyPage = 1,
) {
  if (!user.permissions.includes('inventory.transfer')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view inventory transfers.')
  }
  const branchScope = getAssignedBranchScope(user)
  return withTransaction(async (client) => {
    await client.query('set transaction isolation level repeatable read read only')
    const transfer = await inventoryRepository.findInventoryTransfer(client, id, branchScope)
    if (!transfer) {
      throw new AppError(404, 'TRANSFER_NOT_FOUND', 'Inventory transfer not found.')
    }
    const items = await inventoryRepository.getInventoryTransferItems(client, id)
    const history = user.permissions.includes('audit.read')
      ? await inventoryRepository.getInventoryTransferHistory(client, id, branchScope, historyPage)
      : { history: [], historyTotal: 0 }
    return {
      ...transfer,
      createdAt: transfer.createdAt.toISOString(),
      items,
      ...history,
      historyPage,
      historyPageSize: 25,
    }
  })
}

export async function getInventoryDetail(
  id: string,
  query: InventoryDetailQuery,
  user: AuthenticatedUser,
) {
  const branchScope = requireInventoryRead(user)
  return withTransaction(async (client) => {
    await client.query('set transaction isolation level repeatable read read only')
    const inventory = await detailRepository.findInventoryRecord(client, id, branchScope)
    if (!inventory) throw new AppError(404, 'INVENTORY_NOT_FOUND', 'Inventory record not found.')
    const movements = await detailRepository.getInventoryMovements(
      client,
      inventory,
      query,
      user.permissions,
    )
    const history = user.permissions.includes('audit.read')
      ? await detailRepository.getInventoryHistory(client, inventory, query.historyPage)
      : { history: [], historyTotal: 0 }
    const latest = await findLatestMovement(client, inventory)
    return {
      inventory,
      latestAddition:
        user.permissions.includes('inventory.adjust') && isCorrectableAddition(latest)
          ? { id: latest!.id, quantity: latest!.quantityDelta }
          : null,
      ...movements,
      movementPage: query.movementPage,
      movementPageSize: detailRepository.inventoryPageSize,
      ...history,
      historyPage: query.historyPage,
      historyPageSize: detailRepository.inventoryPageSize,
    }
  })
}

export async function updateInventoryReorder(
  id: string,
  input: InventoryReorderInput,
  user: AuthenticatedUser,
  context: InventoryRequestContext,
) {
  const branchScope = requireInventoryRead(user)
  if (!user.permissions.includes('inventory.reorder')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to change reorder points.')
  }
  return withTransaction(async (client) => {
    const inventory = await detailRepository.findInventoryRecord(client, id, branchScope, true)
    if (!inventory) throw new AppError(404, 'INVENTORY_NOT_FOUND', 'Inventory record not found.')
    // An unchanged form does not create an audit event or touch stock timestamps.
    if (inventory.reorderLevel === input.reorderLevel) return inventory
    const activeTarget = await inventoryRepository.findActiveStockTarget(
      client,
      inventory.productId,
      inventory.branchId,
    )
    if (!activeTarget)
      throw new AppError(
        409,
        'STOCK_TARGET_INACTIVE',
        'Reorder points can only change for an active product and branch.',
      )
    await detailRepository.setInventoryReorder(client, id, input.reorderLevel)
    await detailRepository.insertInventoryReorderAudit(client, {
      inventory,
      reorderLevel: input.reorderLevel,
      ...context,
    })
    return (await detailRepository.findInventoryRecord(client, id, branchScope))!
  })
}

export async function createInventoryTransfer(
  input: InventoryTransferInput,
  context: InventoryRequestContext,
) {
  return withTransaction(async (client) => {
    const transferId = await createTransfer(client, input, context)
    return transferId
  })
}

export async function adjustInventory(
  input: InventoryAdjustmentInput,
  context: InventoryRequestContext,
) {
  const parsed = inventoryAdjustmentSchema.safeParse(input)
  if (!parsed.success)
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Check the stock adjustment values.',
      parsed.error.flatten(),
    )
  try {
    return await withTransaction(async (client) => createAdjustment(client, parsed.data, context))
  } catch (error) {
    if (hasConstraintCode(error, '23514')) {
      throw new AppError(
        409,
        'INSUFFICIENT_STOCK',
        'The adjustment would reduce stock below its reserved quantity.',
      )
    }
    throw error
  }
}

async function createAdjustment(
  client: PoolClient,
  input: InventoryAdjustmentInput,
  context: InventoryRequestContext,
) {
  if (input.requestKey) {
    await inventoryRepository.lockAdjustmentRequest(client, input.requestKey)
    const existing = await inventoryRepository.findAdjustmentRequest(client, input.requestKey)
    if (existing) {
      if (
        existing.transactionType !== 'Adjustment' ||
        existing.productId !== input.productId ||
        existing.branchId !== input.branchId ||
        existing.performedBy !== context.userId ||
        existing.quantityDelta !== input.quantityDelta ||
        existing.note !== (input.note ?? null)
      ) {
        throw new AppError(
          409,
          'REQUEST_KEY_CONFLICT',
          'This adjustment request was already used with different values.',
        )
      }
      return { id: existing.id, quantity: existing.quantity }
    }
  }
  const target = await inventoryRepository.findActiveStockTarget(
    client,
    input.productId,
    input.branchId,
  )
  if (!target) {
    throw new AppError(404, 'STOCK_TARGET_NOT_FOUND', 'Choose an active product and branch.')
  }

  const stock = await inventoryRepository.updateStockQuantity(
    client,
    input.productId,
    input.branchId,
    input.quantityDelta,
  )
  if (!stock) {
    if (!String(input.quantityDelta).startsWith('-')) {
      throw new AppError(
        409,
        'STOCK_QUANTITY_LIMIT',
        'The adjustment would exceed the supported stock quantity limit.',
      )
    }
    throw new AppError(
      409,
      'INSUFFICIENT_STOCK',
      'The adjustment would reduce stock below its reserved quantity.',
    )
  }

  const note = input.note ?? null
  const transactionId = await inventoryRepository.insertInventoryTransaction(client, {
    productId: input.productId,
    branchId: input.branchId,
    quantityDelta: input.quantityDelta,
    note,
    performedBy: context.userId,
    requestKey: input.requestKey ?? null,
  })
  await inventoryRepository.insertInventoryAuditLog(client, {
    userId: context.userId,
    branchId: input.branchId,
    productId: input.productId,
    inventoryId: stock.id,
    quantityDelta: input.quantityDelta,
    note,
    quantity: stock.quantity,
    oldQuantity: stock.oldQuantity,
    ipAddress: context.ipAddress,
    requestId: context.requestId,
  })

  return { id: transactionId, quantity: stock.quantity }
}

async function createTransfer(
  client: PoolClient,
  input: InventoryTransferInput,
  context: InventoryRequestContext,
) {
  const items = [...input.items].sort((first, second) =>
    first.productId.localeCompare(second.productId),
  )
  const note = input.note?.trim() || null
  if (input.requestKey) {
    await inventoryRepository.lockTransferRequest(client, input.requestKey)
    const existing = await inventoryRepository.findTransferRequest(client, input.requestKey)
    if (existing) {
      if (
        existing.fromBranchId !== input.fromBranchId ||
        existing.toBranchId !== input.toBranchId ||
        existing.requestedBy !== context.userId ||
        existing.note !== note ||
        existing.items.length !== items.length ||
        items.some(
          (item, index) =>
            item.productId !== existing.items[index]?.productId ||
            item.quantity !== existing.items[index]?.quantity,
        )
      ) {
        throw new AppError(
          409,
          'REQUEST_KEY_CONFLICT',
          'This transfer request was already used with different values.',
        )
      }
      return { id: existing.id, reference: existing.reference, status: existing.status }
    }
  }
  const branchIds = [input.fromBranchId, input.toBranchId] as [string, string]
  const activeBranches = await inventoryRepository.findActiveTransferBranches(client, branchIds)
  if (activeBranches.size !== 2) {
    throw new AppError(404, 'TRANSFER_BRANCH_NOT_FOUND', 'Choose two active branches.')
  }

  const productIds = input.items.map((item) => item.productId)
  const activeProducts = await inventoryRepository.findActiveTransferProducts(client, productIds)
  if (activeProducts.size !== productIds.length) {
    throw new AppError(404, 'TRANSFER_PRODUCT_NOT_FOUND', 'Choose active products.')
  }

  await inventoryRepository.lockTransferStock(client, productIds, branchIds)

  const reference = `TRF-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`
  const transferId = await inventoryRepository.insertInventoryTransfer(client, {
    reference,
    fromBranchId: input.fromBranchId,
    toBranchId: input.toBranchId,
    requestedBy: context.userId,
    note,
    requestKey: input.requestKey ?? null,
  })
  if (!transferId) {
    throw new AppError(500, 'TRANSFER_CREATE_FAILED', 'The inventory transfer could not be saved.')
  }

  for (const item of items) {
    const sourceStock = await inventoryRepository.removeTransferredStock(client, {
      productId: item.productId,
      branchId: input.fromBranchId,
      quantity: item.quantity,
    })
    if (!sourceStock) {
      throw new AppError(
        409,
        'INSUFFICIENT_STOCK',
        'The source branch does not have enough stock for this transfer.',
      )
    }

    await inventoryRepository.insertInventoryTransferItem(client, {
      transferId,
      productId: item.productId,
      quantity: item.quantity,
    })
    const destinationStock = await inventoryRepository.addTransferredStock(client, {
      productId: item.productId,
      branchId: input.toBranchId,
      quantity: item.quantity,
    })
    if (!destinationStock) {
      throw new AppError(
        409,
        'STOCK_QUANTITY_LIMIT',
        'The transfer would exceed the destination stock quantity limit.',
      )
    }

    await inventoryRepository.insertTransferInventoryTransaction(client, {
      productId: item.productId,
      branchId: input.fromBranchId,
      transactionType: 'TRANSFER_OUT',
      quantityDelta: `-${item.quantity}`,
      transferId,
      note,
      performedBy: context.userId,
    })
    await inventoryRepository.insertTransferInventoryTransaction(client, {
      productId: item.productId,
      branchId: input.toBranchId,
      transactionType: 'TRANSFER_IN',
      quantityDelta: item.quantity,
      transferId,
      note,
      performedBy: context.userId,
    })
  }

  await inventoryRepository.insertInventoryTransferAuditLog(client, {
    userId: context.userId,
    branchId: input.fromBranchId,
    transferId,
    reference,
    fromBranchId: input.fromBranchId,
    toBranchId: input.toBranchId,
    items,
    ipAddress: context.ipAddress,
    requestId: context.requestId,
  })

  return { id: transferId, reference, status: 'Completed' as const }
}

function hasConstraintCode(error: unknown, expectedCode: string): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === expectedCode
  )
}
