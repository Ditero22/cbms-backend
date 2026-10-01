import { Router } from 'express'
import {
  getPaymentFormOptions,
  getCustomerPaymentDetail,
  recordPaymentWithProof,
} from '@/features/payments/payment.service.js'
import { recordPaymentSchema } from '@/features/payments/payment.schemas.js'
import { AppError } from '@/shared/errors/AppError.js'
import { z } from 'zod'
import { financialProofBody, parseFinancialProofBody } from '../financial-proof-body.js'

export const paymentRouter = Router()

paymentRouter.get('/payments/orders/:orderId', async (req, res) => {
  if (!req.user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  const parsed = z.uuid().safeParse(req.params.orderId)
  if (!parsed.success)
    throw new AppError(400, 'VALIDATION_ERROR', 'Choose a valid customer transaction.')
  res.json(await getCustomerPaymentDetail(parsed.data, req.user))
})

paymentRouter.get('/payments/options', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('payments.create')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to record payments.')
  }

  const options = await getPaymentFormOptions({
    branchId: user.branchId,
    isCrossBranch: user.isCrossBranch,
  })
  res.json(options)
})

paymentRouter.post('/payments', async (req) => {
  const user = req.user
  if (!user?.permissions.includes('payments.create')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to record payments.')
  }

  throw new AppError(
    400,
    'PAYMENT_PROOF_REQUIRED',
    'Upload the receipt or payment proof while recording payment.',
  )
})

paymentRouter.post('/payments/with-proof', financialProofBody, async (req, res) => {
  const user = req.user!
  if (!user.permissions.includes('payments.create'))
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to record payments.')
  const { values, proof } = await parseFinancialProofBody(req)
  const parsed = recordPaymentSchema.safeParse(values)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Check the payment details.',
      parsed.error.flatten(),
    )
  }

  const payment = await recordPaymentWithProof(parsed.data, proof, {
    user,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })

  res.status(201).json(payment)
})
