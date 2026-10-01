import { Router } from 'express'
import { z } from 'zod'
import {
  createInventoryTransfer,
  getInventoryTransferDetail,
  getInventoryTransferFormOptions,
} from '@/features/inventory/inventory.service.js'
import { inventoryTransferSchema } from '@/features/inventory/inventory.schemas.js'
import { AppError } from '@/shared/errors/AppError.js'

export const transferRouter = Router()

transferRouter.get('/transfers/options', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('inventory.transfer')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to create transfers.')
  }
  if (!user.isCrossBranch) {
    throw new AppError(
      403,
      'BRANCH_FORBIDDEN',
      'Inventory transfers require access to both branches.',
    )
  }

  res.json(await getInventoryTransferFormOptions())
})

transferRouter.get('/transfers/:transferId', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  if (!user.permissions.includes('inventory.transfer')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view inventory transfers.')
  }
  const parsedId = z.uuid().safeParse(req.params.transferId)
  if (!parsedId.success) {
    throw new AppError(400, 'INVALID_TRANSFER_ID', 'The transfer ID is invalid.')
  }
  const parsedQuery = z
    .object({ historyPage: z.coerce.number().int().min(1).max(10000).optional() })
    .strict()
    .safeParse(req.query)
  if (!parsedQuery.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'The history page is invalid.')
  }
  res.json(await getInventoryTransferDetail(parsedId.data, user, parsedQuery.data.historyPage))
})

transferRouter.post('/transfers', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('inventory.transfer')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to create transfers.')
  }
  if (!user.isCrossBranch) {
    throw new AppError(
      403,
      'BRANCH_FORBIDDEN',
      'Inventory transfers require access to both branches.',
    )
  }

  const parsed = inventoryTransferSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Check the inventory transfer values.',
      parsed.error.flatten(),
    )
  }

  const transfer = await createInventoryTransfer(parsed.data, {
    userId: user.id,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })

  res.status(201).json(transfer)
})
