import { Router } from 'express'
import { getInventoryFormOptions, adjustInventory } from '@/features/inventory/inventory.service.js'
import {
  getInventoryDetail,
  updateInventoryReorder,
} from '@/features/inventory/inventory.service.js'
import { AppError } from '@/shared/errors/AppError.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import {
  inventoryAdjustmentSchema,
  inventoryDetailQuerySchema,
  inventoryReorderSchema,
} from '@/features/inventory/inventory.schemas.js'
import { z } from 'zod'
import { correctLatestStockAddition } from '@/features/inventory/inventory-correction.service.js'
import { inventoryCorrectionSchema } from '@/features/inventory/inventory.schemas.js'

export const inventoryRouter = Router()

inventoryRouter.post('/inventory/:id/corrections', async (req, res) => {
  if (!req.user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  const parsed = inventoryCorrectionSchema.safeParse(req.body)
  if (!parsed.success)
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Check the stock correction.',
      parsed.error.flatten(),
    )
  res.status(201).json(
    await correctLatestStockAddition(inventoryId(req.params.id), parsed.data, req.user, {
      ipAddress: req.ip ?? null,
      requestId: req.requestId ?? null,
    }),
  )
})

function inventoryId(value: unknown) {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success)
    throw new AppError(400, 'VALIDATION_ERROR', 'Choose a valid inventory record.')
  return parsed.data
}

inventoryRouter.get('/inventory/options', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('inventory.read')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view inventory.')
  }

  const options = await getInventoryFormOptions(getAssignedBranchScope(user))
  res.json(options)
})

inventoryRouter.get('/inventory/:id', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('inventory.read'))
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view inventory.')
  const parsed = inventoryDetailQuerySchema.safeParse(req.query)
  if (!parsed.success)
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Check the inventory history filters.',
      parsed.error.flatten(),
    )
  res.json(await getInventoryDetail(inventoryId(req.params.id), parsed.data, user))
})

inventoryRouter.patch('/inventory/:id/reorder', async (req, res) => {
  const user = req.user
  if (
    !user?.permissions.includes('inventory.read') ||
    !user.permissions.includes('inventory.reorder')
  ) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to change reorder points.')
  }
  const parsed = inventoryReorderSchema.safeParse(req.body)
  if (!parsed.success)
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the reorder point.', parsed.error.flatten())
  res.json(
    await updateInventoryReorder(inventoryId(req.params.id), parsed.data, user, {
      userId: user.id,
      ipAddress: req.ip ?? null,
      requestId: req.requestId ?? null,
    }),
  )
})

inventoryRouter.post('/inventory/adjustments', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('inventory.adjust')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to adjust inventory.')
  }

  const parsed = inventoryAdjustmentSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Check the stock adjustment values.',
      parsed.error.flatten(),
    )
  }

  const branchScope = getAssignedBranchScope(user)
  if (branchScope && branchScope !== parsed.data.branchId) {
    throw new AppError(
      403,
      'BRANCH_FORBIDDEN',
      'You can only adjust stock for your assigned branch.',
    )
  }

  const adjustment = await adjustInventory(parsed.data, {
    userId: user.id,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })

  res.status(201).json(adjustment)
})
