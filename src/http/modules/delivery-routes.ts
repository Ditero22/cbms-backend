import { Router } from 'express'
import { z } from 'zod'
import {
  createDelivery,
  getDeliveryDetail,
  getDeliveryFormOptions,
  updateDeliveryStatus,
} from '@/features/deliveries/delivery.service.js'
import {
  createDeliverySchema,
  updateDeliveryStatusSchema,
} from '@/features/deliveries/delivery.schemas.js'
import { AppError } from '@/shared/errors/AppError.js'

export const deliveryRouter = Router()

deliveryRouter.get('/deliveries/options', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('deliveries.create')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to schedule deliveries.')
  }

  const options = await getDeliveryFormOptions({
    branchId: user.branchId,
    isCrossBranch: user.isCrossBranch,
  })
  res.json(options)
})

deliveryRouter.get('/deliveries/:deliveryId', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  if (!user.permissions.includes('deliveries.read')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view deliveries.')
  }
  const parsedId = z.uuid().safeParse(req.params.deliveryId)
  if (!parsedId.success) {
    throw new AppError(400, 'INVALID_DELIVERY_ID', 'The delivery ID is invalid.')
  }
  const parsedQuery = z
    .object({ historyPage: z.coerce.number().int().min(1).max(10000).optional() })
    .strict()
    .safeParse(req.query)
  if (!parsedQuery.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'The history page is invalid.')
  }
  res.json(await getDeliveryDetail(parsedId.data, user, parsedQuery.data.historyPage))
})

deliveryRouter.post('/deliveries', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('deliveries.create')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to schedule deliveries.')
  }

  const parsed = createDeliverySchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Check the delivery details.',
      parsed.error.flatten(),
    )
  }

  const delivery = await createDelivery(parsed.data, {
    userId: user.id,
    permissions: user.permissions,
    branchId: user.branchId,
    isCrossBranch: user.isCrossBranch,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })
  res.status(201).json(delivery)
})

deliveryRouter.patch('/deliveries/:deliveryId/status', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('deliveries.update')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to update deliveries.')
  }

  const parsed = updateDeliveryStatusSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Choose a valid delivery status.',
      parsed.error.flatten(),
    )
  }

  const delivery = await updateDeliveryStatus(
    req.params.deliveryId ?? '',
    parsed.data.status,
    {
      userId: user.id,
      permissions: user.permissions,
      branchId: user.branchId,
      isCrossBranch: user.isCrossBranch,
      ipAddress: req.ip ?? null,
      requestId: req.requestId ?? null,
    },
    { endOdometer: parsed.data.endOdometer, notes: parsed.data.notes },
  )
  res.json(delivery)
})
