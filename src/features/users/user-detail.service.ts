import { AppError } from '@/shared/errors/AppError.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import { assertManagementAdministrator } from '@/shared/security/management-access.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { accountManagementReason, roleManagementReason } from './user-access.js'
import * as detailRepository from './user-detail.repository.js'
import { getRoles } from './user.repository.js'

const historyPageSize = 20

export async function getUserDetail(userId: string, actor: AuthenticatedUser, historyPage = 1) {
  requirePermission(actor, 'users.read')
  const branchId = getAssignedBranchScope(actor)
  const user = await detailRepository.getUserDetail(userId, branchId)
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'The requested user was not found.')
  const managementReason = accountManagementReason(user, actor)
  return {
    user: { ...user, canManage: managementReason === null, managementReason },
    ...(await getHistory('user', userId, actor, historyPage, branchId)),
  }
}

export async function getRoleDetail(roleId: string, actor: AuthenticatedUser, historyPage = 1) {
  requirePermission(actor, 'roles.read')
  const branchId = getAssignedBranchScope(actor)
  const storedRole = (await getRoles(branchId, roleId))[0]
  if (!storedRole) throw new AppError(404, 'ROLE_NOT_FOUND', 'The requested role was not found.')
  const managementReason = roleManagementReason(storedRole, actor)
  const role = {
    id: storedRole.id,
    name: storedRole.name,
    description: storedRole.description,
    isSystem: storedRole.isSystem,
    permissions: storedRole.permissions,
    createdAt: storedRole.createdAt,
    assignedUserCount: storedRole.assignedUserCount,
  }
  return {
    role: { ...role, canManage: managementReason === null, managementReason },
    ...(await getHistory('role', roleId, actor, historyPage, branchId)),
  }
}

async function getHistory(
  entityType: 'user' | 'role',
  id: string,
  actor: AuthenticatedUser,
  page: number,
  branchId?: string,
) {
  const history = actor.permissions.includes('audit.read')
    ? await detailRepository.getManagementHistory(entityType, id, page, historyPageSize, branchId)
    : { items: [], total: 0 }
  // Historical JSON is not an API contract. Only display safe administration fields,
  // including when older/imported audit rows contain unexpected values.
  const safeFields =
    entityType === 'user'
      ? [
          'name',
          'email',
          'roleId',
          'branchId',
          'isCrossBranch',
          'status',
          'deleted',
          'sessionsRevoked',
        ]
      : ['name', 'description', 'permissions']
  const sanitize = (value: Record<string, unknown> | null) =>
    value && Object.fromEntries(Object.entries(value).filter(([key]) => safeFields.includes(key)))
  return {
    history: history.items.map((entry) => ({
      ...entry,
      oldValue: sanitize(entry.oldValue),
      newValue: sanitize(entry.newValue),
    })),
    historyPage: page,
    historyPageSize,
    historyTotal: history.total,
  }
}

function requirePermission(actor: AuthenticatedUser, permission: string) {
  assertManagementAdministrator(actor)
  if (!actor.permissions.includes(permission))
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view this record.')
}
