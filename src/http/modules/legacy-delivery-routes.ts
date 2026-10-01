import { Router, type Request } from 'express'
import { z } from 'zod'
import {
  getLegacyDeliveryReconciliation,
  reconcileLegacyDelivery,
} from '@/features/orders/legacy-delivery.service.js'
import { reconcileLegacyDeliverySchema } from '@/features/orders/legacy-delivery.schemas.js'
import { AppError } from '@/shared/errors/AppError.js'

export const legacyDeliveryRouter = Router()

legacyDeliveryRouter.get('/orders/:orderId/legacy-delivery-reconciliation', async (req, res) => {
  const user = requireUser(req.user)
  res.json(await getLegacyDeliveryReconciliation(parseId(req.params.orderId, 'order'), user))
})

legacyDeliveryRouter.put(
  '/orders/:orderId/legacy-deliveries/:deliveryId/reconcile',
  async (req, res) => {
    const user = requireUser(req.user)
    const input = reconcileLegacyDeliverySchema.safeParse(req.body)
    if (!input.success) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Provide the confirmed quantity for every order line and an evidence note.',
        input.error.flatten(),
      )
    }
    res.json(
      await reconcileLegacyDelivery(
        parseId(req.params.orderId, 'order'),
        parseId(req.params.deliveryId, 'delivery'),
        input.data,
        { user, ipAddress: req.ip ?? null, requestId: req.requestId ?? null },
      ),
    )
  },
)

function requireUser(user: Request['user']) {
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  return user
}

function parseId(value: string | undefined, label: string) {
  const result = z.uuid().safeParse(value)
  if (!result.success) {
    throw new AppError(400, `INVALID_${label.toUpperCase()}_ID`, `The ${label} ID is invalid.`)
  }
  return result.data
}
