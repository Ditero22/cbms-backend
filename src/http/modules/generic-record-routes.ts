import { Router } from 'express'
import {
  archiveModuleRecord,
  createModuleRecord,
  getCustomerCreateOptions,
  getModuleRecord,
  getProductOptions,
  listModuleRecords,
  updateModuleRecord,
} from '@/features/records/record.service.js'
import { AppError } from '@/shared/errors/AppError.js'
import { z } from 'zod'

export const genericRecordRouter = Router()

genericRecordRouter.get('/:moduleId', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')

  const records = await listModuleRecords(req.params.moduleId ?? '', user, req.query)
  res.json(records)
})

genericRecordRouter.post('/:moduleId', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')

  const record = await createModuleRecord(req.params.moduleId ?? '', req.body, {
    user,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })

  res.status(201).json(record)
})

genericRecordRouter.get('/products/options', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  res.json(await getProductOptions(user))
})

genericRecordRouter.get('/customers/options', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  res.json(await getCustomerCreateOptions(user))
})

genericRecordRouter.get('/:moduleId/:recordId', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  const recordId = parseRecordId(req.params.recordId)
  res.json(await getModuleRecord(req.params.moduleId ?? '', recordId, user))
})

genericRecordRouter.patch('/:moduleId/:recordId/archive', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  const body = z
    .object({})
    .strict()
    .safeParse(req.body ?? {})
  if (!body.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Archiving does not accept form fields.')
  }
  const recordId = parseRecordId(req.params.recordId)
  res.json(
    await archiveModuleRecord(req.params.moduleId ?? '', recordId, {
      user,
      ipAddress: req.ip ?? null,
      requestId: req.requestId ?? null,
    }),
  )
})

genericRecordRouter.patch('/:moduleId/:recordId', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  const recordId = parseRecordId(req.params.recordId)
  res.json(
    await updateModuleRecord(req.params.moduleId ?? '', recordId, req.body, {
      user,
      ipAddress: req.ip ?? null,
      requestId: req.requestId ?? null,
    }),
  )
})

function parseRecordId(value: string | undefined) {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success) throw new AppError(400, 'INVALID_RECORD_ID', 'The record ID is invalid.')
  return parsed.data
}
