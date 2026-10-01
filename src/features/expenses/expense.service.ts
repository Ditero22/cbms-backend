import { getExpenseBranches } from './expense.repository.js'
import { withTransaction } from '@/database/transaction.js'
import { AppError } from '@/shared/errors/AppError.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import {
  expenseCreateSchema,
  type ExpenseDetailQuery,
  type ExpenseReviewInput,
} from './expense.schemas.js'
import * as expenseRepository from './expense.repository.js'
import * as detailRepository from './expense-detail.repository.js'

type ExpenseReviewContext = {
  user: AuthenticatedUser
  ipAddress: string | null
  requestId: string | null
}

export async function getExpenseFormOptions(branchId?: string | null, canRead = true) {
  const branches = await getExpenseBranches(branchId)
  const categories = canRead
    ? await expenseRepository.getExpenseCategories(branchId ?? undefined)
    : []
  return { branches, categories }
}

export async function createExpense(input: unknown, context: ExpenseReviewContext) {
  const user = context.user
  if (!user.permissions.includes('expenses.create'))
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to create expenses.')
  const parsed = expenseCreateSchema.safeParse(input)
  if (!parsed.success)
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the entered values.', parsed.error.flatten())
  const branchScope = getAssignedBranchScope(user)
  const branchId = parsed.data.branchId ?? user.branchId
  if (!branchId) throw new AppError(400, 'BRANCH_REQUIRED', 'Choose a branch for this expense.')
  if (branchScope && branchScope !== branchId)
    throw new AppError(
      403,
      'BRANCH_FORBIDDEN',
      'You can only record expenses for your assigned branch.',
    )
  return withTransaction(async (client) => {
    if (parsed.data.requestKey) {
      await expenseRepository.lockExpenseRequest(client, parsed.data.requestKey)
      const existing = await expenseRepository.findExpenseRequest(client, parsed.data.requestKey)
      if (existing) {
        if (
          existing.submittedBy !== user.id ||
          existing.branchId !== branchId ||
          existing.amount !== parsed.data.amount ||
          existing.description !== parsed.data.description ||
          existing.category !== parsed.data.category
        ) {
          throw new AppError(
            409,
            'REQUEST_KEY_CONFLICT',
            'This expense request was already used with different values.',
          )
        }
        return { id: existing.id }
      }
    }
    if (!(await expenseRepository.isActiveExpenseBranch(client, branchId)))
      throw new AppError(400, 'INVALID_BRANCH', 'Choose an active branch.')
    const id = await expenseRepository.insertManualExpense(client, parsed.data, branchId, user.id)
    await expenseRepository.insertManualExpenseAudit(client, {
      id,
      branchId,
      userId: user.id,
      description: parsed.data.description,
      category: parsed.data.category,
      amount: parsed.data.amount,
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })
    return { id }
  })
}

export async function getExpenseDetail(
  expenseId: string,
  query: ExpenseDetailQuery,
  user: AuthenticatedUser,
) {
  if (!user.permissions.includes('expenses.read'))
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view expenses.')
  const branchScope = getAssignedBranchScope(user)
  return withTransaction(async (client) => {
    await client.query('set transaction isolation level repeatable read read only')
    const expense = await detailRepository.findExpenseDetail(client, expenseId, branchScope)
    if (!expense) throw new AppError(404, 'EXPENSE_NOT_FOUND', 'Expense not found.')
    const review = await detailRepository.findExpenseReview(client, expense)
    const source = await detailRepository.findExpenseSource(client, expense, user.permissions)
    const history = user.permissions.includes('audit.read')
      ? await detailRepository.getExpenseHistory(client, expense, query.historyPage)
      : { history: [], historyTotal: 0 }
    return {
      expense,
      review,
      source,
      ...history,
      historyPage: query.historyPage,
      historyPageSize: detailRepository.expenseHistoryPageSize,
    }
  })
}

export async function reviewExpense(
  expenseId: string,
  input: ExpenseReviewInput,
  context: ExpenseReviewContext,
) {
  if (!context.user.permissions.includes('expenses.approve')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to review expenses.')
  }

  const branchScope = getAssignedBranchScope(context.user)
  return withTransaction(async (client) => {
    const expense = await expenseRepository.lockExpenseForReview(client, expenseId, branchScope)
    if (!expense) throw new AppError(404, 'EXPENSE_NOT_FOUND', 'Expense not found.')
    if (expense.status !== 'Pending') {
      throw new AppError(
        409,
        'EXPENSE_ALREADY_REVIEWED',
        'This expense is no longer pending review.',
      )
    }

    await expenseRepository.saveExpenseReview(client, expenseId, context.user.id, input.decision)
    const newValue = {
      ...expense,
      status: input.decision,
      reviewNote: input.note ?? null,
      reviewerId: context.user.id,
    }
    await expenseRepository.insertExpenseReviewAudit(client, {
      userId: context.user.id,
      branchId: expense.branchId,
      expenseId,
      oldValue: expense,
      newValue,
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })

    return { id: expenseId, status: input.decision }
  })
}
