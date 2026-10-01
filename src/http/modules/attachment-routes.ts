import express, { Router } from 'express'
import { z } from 'zod'
import {
  authorizeProof,
  getProofContent,
  listProofs,
  uploadProof,
} from '@/features/attachments/attachment.service.js'
import { maxProofBytes, proofEntitySchema } from '@/features/attachments/attachment.schemas.js'
import { AppError } from '@/shared/errors/AppError.js'

export const attachmentRouter = Router()

attachmentRouter.get('/attachments', async (req, res) => {
  const entity = proofEntitySchema.safeParse(req.query)
  if (!entity.success) throw new AppError(400, 'VALIDATION_ERROR', 'Choose a valid proof record.')
  res.json(await listProofs(entity.data, req.user!))
})

attachmentRouter.post(
  '/attachments',
  async (req, _res, next) => {
    const parsed = proofEntitySchema.safeParse(req.query)
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Choose a valid proof record.')
    await authorizeProof(parsed.data, req.user!, true)
    next()
  },
  express.raw({
    type: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    limit: maxProofBytes,
  }),
  async (req, res) => {
    const entity = proofEntitySchema.parse(req.query)
    let fileName = ''
    try {
      fileName = decodeURIComponent(req.get('x-file-name') ?? '')
    } catch {
      throw new AppError(400, 'INVALID_PROOF_NAME', 'The file name is invalid.')
    }
    const saved = await uploadProof(
      entity,
      fileName,
      (req.get('content-type') ?? '').split(';')[0]!,
      req.body,
      { user: req.user!, ipAddress: req.ip ?? null, requestId: req.requestId ?? null },
    )
    res.status(201).json(saved)
  },
)

attachmentRouter.get('/attachments/:id/content', async (req, res) => {
  const id = z.uuid().safeParse(req.params.id)
  if (!id.success) throw new AppError(400, 'INVALID_PROOF_ID', 'The proof ID is invalid.')
  const proof = await getProofContent(id.data, req.user!)
  res.set({
    'Content-Type': proof.mimeType,
    'Content-Disposition': `attachment; filename="proof"; filename*=UTF-8''${encodeURIComponent(proof.fileName)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Content-Length': String(proof.bytes.length),
  })
  res.send(proof.bytes)
})
