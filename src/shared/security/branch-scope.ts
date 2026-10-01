import { AppError } from '@/shared/errors/AppError.js'

export function getAssignedBranchScope(user: { branchId: string | null; isCrossBranch: boolean }) {
  if (user.isCrossBranch) return undefined
  if (!user.branchId) {
    throw new AppError(
      403,
      'BRANCH_REQUIRED',
      'Assign this account to a branch before accessing branch-scoped data.',
    )
  }
  return user.branchId
}
