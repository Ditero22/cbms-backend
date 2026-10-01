import type { AuthenticatedUser } from '@/shared/types/auth.js'

export function accountManagementReason(
  account: { id: string; branchId: string | null; isCrossBranch: boolean; permissions: string[] },
  actor: AuthenticatedUser,
) {
  if (!actor.isCrossBranch) return 'Only administrators can manage accounts.'
  if (!actor.permissions.includes('users.update'))
    return 'You do not have permission to manage accounts.'
  if (account.id === actor.id)
    return 'Another administrator must manage your role, branch access, status, and password.'
  if (!actor.isCrossBranch && (account.isCrossBranch || account.branchId !== actor.branchId)) {
    return 'An administrator with cross-branch access must manage this account.'
  }
  if (account.permissions.some((key) => !actor.permissions.includes(key))) {
    return 'This account has permissions beyond your own. Ask an administrator with the required permissions.'
  }
  return null
}

export function roleManagementReason(
  role: { isSystem: number; permissions: string[]; hasOutOfScopeUsers: boolean },
  actor: AuthenticatedUser,
) {
  if (!actor.isCrossBranch) return 'Only administrators can manage roles.'
  if (!actor.permissions.includes('roles.update'))
    return 'You do not have permission to manage roles.'
  if (role.isSystem === 1) return 'The built-in administrator role is protected.'
  if (role.permissions.some((key) => !actor.permissions.includes(key))) {
    return 'This role has permissions beyond your own.'
  }
  if (role.hasOutOfScopeUsers)
    return 'This role is assigned outside your branch. Ask an administrator with cross-branch access.'
  return null
}
