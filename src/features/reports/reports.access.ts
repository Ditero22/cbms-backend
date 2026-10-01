import { AppError } from '@/shared/errors/AppError.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

export function requireReportAccess(user: AuthenticatedUser, forExport = false) {
  if (!user.permissions.includes('reports.view')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view reports.')
  }
  if (forExport && !user.permissions.includes('reports.export')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to export reports.')
  }

  return getAssignedBranchScope(user)
}
