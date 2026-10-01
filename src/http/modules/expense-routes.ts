import { Router } from 'express'
import { getExpenseFormOptions, reviewExpense } from '@/features/expenses/expense.service.js'
import { getExpenseDetail } from '@/features/expenses/expense.service.js'
import { expenseReviewSchema } from '@/features/expenses/expense.schemas.js'
import { expenseDetailQuerySchema } from '@/features/expenses/expense.schemas.js'
import { AppError } from '@/shared/errors/AppError.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import { z } from 'zod'

export const expenseRouter = Router()

expenseRouter.get('/expenses/options', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('expenses.create')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to create expenses.')
  }

  const options = await getExpenseFormOptions(
    getAssignedBranchScope(user),
    user.permissions.includes('expenses.read'),
  )
  res.json(options)
})

expenseRouter.get('/expenses/:expenseId', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('expenses.read'))
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view expenses.')
  const parsedId = z.uuid().safeParse(req.params.expenseId)
  if (!parsedId.success) throw new AppError(400, 'INVALID_EXPENSE_ID', 'The expense ID is invalid.')
  const parsed = expenseDetailQuerySchema.safeParse(req.query)
  if (!parsed.success)
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Check the expense history page.',
      parsed.error.flatten(),
    )
  res.json(await getExpenseDetail(parsedId.data, parsed.data, user))
})

expenseRouter.patch('/expenses/:expenseId/review', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')

  const parsedId = z.uuid().safeParse(req.params.expenseId)
  if (!parsedId.success) {
    throw new AppError(400, 'INVALID_EXPENSE_ID', 'The expense ID is invalid.')
  }
  const parsed = expenseReviewSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Check the review decision and notes.',
      parsed.error.flatten(),
    )
  }

  const result = await reviewExpense(parsedId.data, parsed.data, {
    user,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })
  res.json(result)
})
