import express from 'express'
import type { Request } from 'express'
import { AppError } from '@/shared/errors/AppError.js'
import { validateProofInput } from '@/features/attachments/proof-input.js'

export const financialProofBody = express.raw({ type: 'multipart/form-data', limit: '11mb' })

export async function parseFinancialProofBody(req: Pick<Request, 'body' | 'get'>) {
  if (!Buffer.isBuffer(req.body))
    throw new AppError(
      400,
      'PAYMENT_PROOF_REQUIRED',
      'Choose a payment proof image before recording payment.',
    )
  let form: FormData
  try {
    form = await new Response(req.body, {
      headers: { 'Content-Type': req.get('content-type') ?? '' },
    }).formData()
  } catch {
    throw new AppError(
      400,
      'INVALID_PAYMENT_FORM',
      'The payment form could not be read. Select the proof and try again.',
    )
  }
  if (
    [...form.keys()].some((key) => !['data', 'proofFile'].includes(key)) ||
    form.getAll('data').length !== 1 ||
    form.getAll('proofFile').length !== 1
  )
    throw new AppError(
      400,
      'INVALID_PAYMENT_FORM',
      'Provide payment details and exactly one proof image.',
    )
  const data = form.get('data')
  const file = form.get('proofFile')
  if (typeof data !== 'string' || data.length > 10_000 || !(file instanceof File))
    throw new AppError(400, 'PAYMENT_PROOF_REQUIRED', 'Provide payment details and a proof image.')
  let values: unknown
  try {
    values = JSON.parse(data)
  } catch {
    throw new AppError(400, 'INVALID_PAYMENT_FORM', 'The payment details are invalid.')
  }
  const proof = validateProofInput(
    file.name,
    file.type,
    Buffer.from(await file.arrayBuffer()),
    true,
  )
  return { values, proof }
}
