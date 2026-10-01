import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createModuleRecord } from '@/features/records/record.service.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

const { insertManualExpense, insertManualExpenseAudit, isActiveExpenseBranch } = vi.hoisted(() => ({
  insertManualExpense: vi.fn(),
  insertManualExpenseAudit: vi.fn(),
  isActiveExpenseBranch: vi.fn(),
}))

vi.mock('@/database/transaction.js', () => ({
  withTransaction: async (operation: (client: object) => Promise<unknown>) => operation({}),
}))

vi.mock('@/features/records/record.repository.js', () => ({}))

vi.mock('@/features/expenses/expense.repository.js', () => ({
  insertManualExpense,
  insertManualExpenseAudit,
  isActiveExpenseBranch,
}))

const branchId = '00000000-0000-4000-8000-000000000002'
const user: AuthenticatedUser = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Expense clerk',
  email: 'clerk@example.invalid',
  role: 'Clerk',
  branchId,
  branch: 'North',
  isCrossBranch: false,
  permissions: ['expenses.create'],
}

describe('expense creation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    insertManualExpense.mockResolvedValue('00000000-0000-4000-8000-000000000003')
    isActiveExpenseBranch.mockResolvedValue(true)
  })

  it('inserts the authenticated submitter required by the database', async () => {
    await createModuleRecord(
      'expenses',
      { description: 'Fuel', category: 'Operations', amount: 125.5 },
      { user, ipAddress: null, requestId: null },
    )

    expect(insertManualExpense).toHaveBeenCalledWith(
      expect.anything(),
      { description: 'Fuel', category: 'Operations', amount: '125.50' },
      branchId,
      user.id,
    )
    expect(insertManualExpenseAudit).toHaveBeenCalledOnce()
  })

  it('does not allow the request body to choose another submitter', async () => {
    await expect(
      createModuleRecord(
        'expenses',
        {
          description: 'Fuel',
          category: 'Operations',
          amount: 125.5,
          submittedBy: '00000000-0000-4000-8000-000000000004',
        },
        { user, ipAddress: null, requestId: null },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })

    expect(insertManualExpense).not.toHaveBeenCalled()
  })
})
