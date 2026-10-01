import { AppError } from '@/shared/errors/AppError.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

/** Authentication derives this flag only from the protected system Admin role. */
export function assertManagementAdministrator(user: AuthenticatedUser) {
  if (!user.isCrossBranch) {
    throw new AppError(403, 'MANAGEMENT_FORBIDDEN', 'Only administrators can access Management.')
  }
}
