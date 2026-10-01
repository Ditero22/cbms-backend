import { Router } from 'express'
import { z } from 'zod'
import {
  confirmPayrollEntryReceived,
  createPayrollRun,
  getPayrollOptions,
  getPayrollRunDetail,
  markPayrollEntryPaidWithProof,
  processPayrollRun,
  updatePayrollRun,
} from '@/features/payroll/payroll.service.js'
import {
  confirmPayrollReceiptSchema,
  createPayrollRunSchema,
  markPayrollPaidSchema,
  payrollDetailQuerySchema,
  payrollOptionsQuerySchema,
  updatePayrollRunSchema,
  payrollLedgerQuerySchema,
} from '@/features/payroll/payroll.schemas.js'
import { AppError } from '@/shared/errors/AppError.js'
import {
  getPayrollEntryDetail,
  getPayrollLedger,
} from '@/features/payroll/payroll-ledger.repository.js'
import { financialProofBody, parseFinancialProofBody } from '../financial-proof-body.js'

export const payrollRouter = Router()

function parseUuid(value: string | undefined) {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success) throw new AppError(400, 'INVALID_PAYROLL_ID', 'The payroll ID is invalid.')
  return parsed.data
}

function parseQuery<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', message, parsed.error.flatten())
  return parsed.data
}

payrollRouter.get('/payroll/options', async (req, res) => {
  const query = parseQuery(payrollOptionsQuerySchema, req.query, 'Choose a valid branch.')
  res.json(await getPayrollOptions(req.user!, query.branchId))
})

payrollRouter.get('/payroll/entries', async (req, res) => {
  const query = parseQuery(payrollLedgerQuerySchema, req.query, 'Choose valid payroll filters.')
  res.json(await getPayrollLedger(query, req.user!))
})

payrollRouter.get('/payroll/entries/:entryId', async (req, res) => {
  res.json(await getPayrollEntryDetail(parseUuid(req.params.entryId), req.user!))
})

payrollRouter.get('/payroll/:id', async (req, res) => {
  const query = parseQuery(payrollDetailQuerySchema, req.query, 'Choose a valid employee page.')
  res.json(await getPayrollRunDetail(parseUuid(req.params.id), req.user!, query.page, query.limit))
})

payrollRouter.post('/payroll', async (req, res) => {
  const input = parseQuery(createPayrollRunSchema, req.body, 'Enter a valid pay run.')
  res.status(201).json(
    await createPayrollRun(input, {
      user: req.user!,
      ipAddress: req.ip ?? null,
      requestId: req.requestId ?? null,
    }),
  )
})

payrollRouter.patch('/payroll/:id', async (req, res) => {
  const input = parseQuery(updatePayrollRunSchema, req.body, 'Enter a valid pay run.')
  res.json(
    await updatePayrollRun(parseUuid(req.params.id), input, {
      user: req.user!,
      ipAddress: req.ip ?? null,
      requestId: req.requestId ?? null,
    }),
  )
})

payrollRouter.post('/payroll/:id/process', async (req, res) => {
  const body = parseQuery(
    z.object({}).strict(),
    req.body ?? {},
    'Processing does not accept form fields.',
  )
  void body
  res.json(
    await processPayrollRun(parseUuid(req.params.id), {
      user: req.user!,
      ipAddress: req.ip ?? null,
      requestId: req.requestId ?? null,
    }),
  )
})

payrollRouter.post('/payroll/entries/:entryId/pay', async (req) => {
  if (!req.user!.permissions.includes('payroll.pay'))
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to record payroll payments.')
  throw new AppError(
    400,
    'PAYMENT_PROOF_REQUIRED',
    'Upload the receipt or payment proof while recording payment.',
  )
})

payrollRouter.post(
  '/payroll/entries/:entryId/pay-with-proof',
  financialProofBody,
  async (req, res) => {
    if (!req.user!.permissions.includes('payroll.pay'))
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to record payroll payments.')
    const { values, proof } = await parseFinancialProofBody(req)
    const parsed = markPayrollPaidSchema.safeParse(values)
    if (!parsed.success) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Enter the actual payment details.',
        parsed.error.flatten(),
      )
    }
    res.json(
      await markPayrollEntryPaidWithProof(parseUuid(req.params.entryId), parsed.data, proof, {
        user: req.user!,
        ipAddress: req.ip ?? null,
        requestId: req.requestId ?? null,
      }),
    )
  },
)

payrollRouter.post('/payroll/entries/:entryId/receive', async (req, res) => {
  const parsed = confirmPayrollReceiptSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Enter a valid receipt confirmation.',
      parsed.error.flatten(),
    )
  }
  res.json(
    await confirmPayrollEntryReceived(parseUuid(req.params.entryId), parsed.data, {
      user: req.user!,
      ipAddress: req.ip ?? null,
      requestId: req.requestId ?? null,
    }),
  )
})
