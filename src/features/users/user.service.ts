import type { PoolClient } from 'pg'
import { withTransaction } from '@/database/transaction.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { AppError } from '@/shared/errors/AppError.js'
import { hashPassword } from '@/shared/security/password.js'
import { permissionKeys } from '@/database/permissions.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import { assertManagementAdministrator } from '@/shared/security/management-access.js'
import type {
  CreateRoleInput,
  CreateUserInput,
  ResetUserPasswordInput,
  UpdateRoleInput,
  UpdateUserInput,
} from './user.schemas.js'
import * as userRepository from './user.repository.js'
import { roleManagementReason } from './user-access.js'

type RequestContext = {
  user: AuthenticatedUser
  ipAddress: string | null
  requestId: string | null
}

export async function getUserOptions(user: AuthenticatedUser) {
  assertManagementAdministrator(user)
  const options = await userRepository.getUserManagementOptions(getAssignedBranchScope(user))
  const roles = options.roles.filter((role) =>
    role.permissions.every((key) => user.permissions.includes(key)),
  )

  return {
    roles,
    branches: options.branches,
    permissions: permissionKeys.filter((permission) => user.permissions.includes(permission)),
  }
}

export async function listRoles(user: AuthenticatedUser) {
  assertManagementAdministrator(user)
  const roles = await userRepository.getRoles(getAssignedBranchScope(user))
  return roles.map(({ hasOutOfScopeUsers, ...role }) => {
    const managementReason = roleManagementReason({ ...role, hasOutOfScopeUsers }, user)
    return { ...role, canManage: managementReason === null, managementReason }
  })
}

export function getRolePermissionOptions(user: AuthenticatedUser) {
  assertManagementAdministrator(user)
  return permissionKeys.filter((permission) => user.permissions.includes(permission))
}

export async function createRole(input: CreateRoleInput, context: RequestContext) {
  assertManagementAdministrator(context.user)
  ensureCanGrantPermissions(input.permissions, context.user)

  try {
    return await withTransaction(async (client) => {
      const roleId = await userRepository.insertRole(client, {
        name: input.name,
        description: input.description ?? null,
      })
      if (!roleId) throw new AppError(500, 'ROLE_CREATE_FAILED', 'The role could not be saved.')

      await userRepository.setRolePermissions(client, roleId, input.permissions)
      await userRepository.insertRoleAudit(client, {
        userId: context.user.id,
        roleId,
        action: 'created role',
        data: { name: input.name, permissions: input.permissions },
        branchId: context.user.branchId,
        ipAddress: context.ipAddress,
        requestId: context.requestId,
      })

      return { id: roleId }
    })
  } catch (error) {
    if (hasConstraintCode(error, '23505')) {
      throw new AppError(409, 'DUPLICATE_ROLE', 'A role with this name already exists.')
    }
    throw error
  }
}

export async function updateRole(roleId: string, input: UpdateRoleInput, context: RequestContext) {
  assertManagementAdministrator(context.user)
  if (input.permissions) ensureCanGrantPermissions(input.permissions, context.user)

  try {
    return await withTransaction(async (client) => {
      await userRepository.lockRole(client, roleId)
      const existing = await userRepository.getRoleById(client, roleId)
      if (!existing) throw new AppError(404, 'ROLE_NOT_FOUND', 'The requested role was not found.')
      if (existing.is_system === 1) {
        throw new AppError(
          409,
          'SYSTEM_ROLE_LOCKED',
          'The built-in administrator role cannot be changed.',
        )
      }
      await assertManageableRole(client, existing, context.user)

      await userRepository.updateRole(client, roleId, input)
      if (input.permissions) {
        await userRepository.setRolePermissions(client, roleId, input.permissions)
        if (
          existing.permissions.length !== input.permissions.length ||
          existing.permissions.some((key) => !input.permissions?.includes(key))
        ) {
          await userRepository.revokeRoleSessions(client, roleId)
        }
      }
      await userRepository.insertRoleAudit(client, {
        userId: context.user.id,
        roleId,
        action: 'updated role',
        data: input,
        oldData: {
          name: existing.name,
          description: existing.description,
          permissions: existing.permissions,
        },
        branchId: context.user.branchId,
        ipAddress: context.ipAddress,
        requestId: context.requestId,
      })

      return { id: roleId }
    })
  } catch (error) {
    if (hasConstraintCode(error, '23505')) {
      throw new AppError(409, 'DUPLICATE_ROLE', 'A role with this name already exists.')
    }
    throw error
  }
}

export async function createUser(input: CreateUserInput, context: RequestContext) {
  assertManagementAdministrator(context.user)
  const passwordHash = await hashPassword(input.password)

  try {
    return await withTransaction(async (client) => {
      const role = await assertAssignableRole(client, input.roleId, context.user)
      assertRoleAndBranchAssignment(role, input.branchId, input.isCrossBranch, context.user)
      await assertActiveBranch(client, input.branchId, input.isCrossBranch)

      const userId = await userRepository.insertUser(client, {
        name: input.name,
        email: input.email,
        passwordHash,
        roleId: input.roleId,
        branchId: input.branchId,
        isCrossBranch: input.isCrossBranch,
      })
      if (!userId)
        throw new AppError(500, 'USER_CREATE_FAILED', 'The user account could not be saved.')

      await userRepository.insertUserAudit(client, {
        actorId: context.user.id,
        userId,
        action: 'created user',
        data: {
          name: input.name,
          email: input.email,
          roleId: input.roleId,
          branchId: input.branchId,
          isCrossBranch: input.isCrossBranch,
        },
        branchId: input.branchId,
        ipAddress: context.ipAddress,
        requestId: context.requestId,
      })

      return { id: userId }
    })
  } catch (error) {
    if (hasConstraintCode(error, '23505')) {
      throw new AppError(409, 'DUPLICATE_USER', 'An account with this email already exists.')
    }
    throw error
  }
}

export async function deleteRole(roleId: string, context: RequestContext) {
  assertManagementAdministrator(context.user)
  return withTransaction(async (client) => {
    await userRepository.lockRole(client, roleId)
    const existing = await userRepository.getRoleById(client, roleId)
    if (!existing) throw new AppError(404, 'ROLE_NOT_FOUND', 'The requested role was not found.')
    if (existing.is_system === 1) {
      throw new AppError(
        409,
        'SYSTEM_ROLE_LOCKED',
        'The built-in administrator role cannot be deleted.',
      )
    }
    await assertManageableRole(client, existing, context.user)
    if ((await userRepository.countUsersInRole(client, roleId)) > 0) {
      throw new AppError(409, 'ROLE_IN_USE', 'Reassign users before deleting this role.')
    }

    await userRepository.insertRoleAudit(client, {
      userId: context.user.id,
      roleId,
      action: 'deleted role',
      data: { name: existing.name },
      oldData: {
        name: existing.name,
        description: existing.description,
        permissions: existing.permissions,
      },
      branchId: context.user.branchId,
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })
    await userRepository.deleteRole(client, roleId)
    return { id: roleId }
  })
}

export async function updateUser(userId: string, input: UpdateUserInput, context: RequestContext) {
  assertManagementAdministrator(context.user)
  if (
    userId === context.user.id &&
    (input.roleId ||
      input.branchId !== undefined ||
      input.isCrossBranch !== undefined ||
      input.status === 'Inactive')
  ) {
    throw new AppError(
      409,
      'SELF_ADMIN_CHANGE',
      'You cannot change your own role, branch access, or active status.',
    )
  }

  return withTransaction(async (client) => {
    // Acquire role locks before account locks so concurrent administrator edits
    // cannot deadlock while each transaction holds a different user row.
    await userRepository.lockSystemAdministratorRole(client)
    const existing = await userRepository.getUserById(client, userId)
    if (!existing) throw new AppError(404, 'USER_NOT_FOUND', 'The requested user was not found.')
    assertExistingAccountScope(existing, context.user)
    await userRepository.lockAccountRoles(client, [
      existing.role_id,
      ...(input.roleId ? [input.roleId] : []),
    ])
    const existingRole = await userRepository.getRoleById(client, existing.role_id)
    assertExistingAccountPermissions(
      existingRole?.permissions ?? existing.permissions,
      context.user,
    )

    const nextBranchId = input.branchId === undefined ? existing.branch_id : input.branchId
    const existingCrossBranch = existing.is_cross_branch === 1 && existing.is_system_role === 1
    const nextCrossBranch = input.isCrossBranch ?? existingCrossBranch
    const nextRole = input.roleId
      ? await assertAssignableRole(client, input.roleId, context.user)
      : existingRole
    assertRoleAndBranchAssignment(nextRole, nextBranchId, nextCrossBranch, context.user)
    await assertActiveBranch(client, nextBranchId, nextCrossBranch)
    const removesSystemAdmin =
      existing.is_system_role === 1 &&
      existing.status === 'Active' &&
      ((input.roleId !== undefined && input.roleId !== existing.role_id) ||
        input.status === 'Inactive')
    if (removesSystemAdmin) {
      if ((await userRepository.countActiveSystemAdministrators(client)) <= 1) {
        throw new AppError(
          409,
          'LAST_ADMIN_REQUIRED',
          'At least one active administrator must remain.',
        )
      }
    }

    // The account row is locked above. Compare with its persisted access values;
    // edit forms may submit unchanged assignments alongside a name change.
    const accessChanged =
      (input.roleId !== undefined && input.roleId !== existing.role_id) ||
      (input.branchId !== undefined && input.branchId !== existing.branch_id) ||
      (input.isCrossBranch !== undefined && input.isCrossBranch !== existingCrossBranch) ||
      (input.status !== undefined && input.status !== existing.status)
    await userRepository.updateUser(client, userId, input, accessChanged)
    await userRepository.insertUserAudit(client, {
      actorId: context.user.id,
      userId,
      action: 'updated user',
      data: input,
      oldData: {
        name: existing.name,
        roleId: existing.role_id,
        branchId: existing.branch_id,
        isCrossBranch: existingCrossBranch,
        status: existing.status,
      },
      branchId: nextBranchId,
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })

    return { id: userId }
  })
}

export async function deleteUserAccount(userId: string, context: RequestContext) {
  assertManagementAdministrator(context.user)
  if (userId === context.user.id) {
    throw new AppError(
      409,
      'SELF_ACCOUNT_DELETE',
      'You cannot delete your own account. Another administrator must manage it.',
    )
  }

  return withTransaction(async (client) => {
    // Serialize deletion with Administrator status changes and other deletions
    // before locking the target account, matching the existing account-write order.
    await userRepository.lockSystemAdministratorRole(client)
    const existing = await userRepository.getUserById(client, userId)
    if (!existing) throw new AppError(404, 'USER_NOT_FOUND', 'The requested user was not found.')
    assertExistingAccountScope(existing, context.user)

    await userRepository.lockAccountRoles(client, [existing.role_id])
    const existingRole = await userRepository.getRoleById(client, existing.role_id)
    assertExistingAccountPermissions(
      existingRole?.permissions ?? existing.permissions,
      context.user,
    )

    if (
      existing.is_system_role === 1 &&
      existing.status === 'Active' &&
      (await userRepository.countActiveSystemAdministrators(client)) <= 1
    ) {
      throw new AppError(
        409,
        'LAST_ADMIN_REQUIRED',
        'At least one active administrator must remain.',
      )
    }

    const deleted = await userRepository.softDeleteUser(client, userId, context.user.id)
    if (!deleted)
      throw new AppError(
        409,
        'USER_DELETE_CONFLICT',
        'The account has changed. Reload and try again.',
      )

    await userRepository.insertUserAudit(client, {
      actorId: context.user.id,
      userId,
      action: 'deleted user account',
      data: { status: 'Inactive', deleted: true, sessionsRevoked: true },
      oldData: {
        name: existing.name,
        roleId: existing.role_id,
        branchId: existing.branch_id,
        isCrossBranch: existing.is_cross_branch === 1 && existing.is_system_role === 1,
        status: existing.status,
      },
      branchId: existing.branch_id,
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })

    return { id: userId }
  })
}

export async function resetUserPassword(
  userId: string,
  input: ResetUserPasswordInput,
  context: RequestContext,
) {
  assertManagementAdministrator(context.user)
  if (userId === context.user.id) {
    throw new AppError(
      409,
      'SELF_PASSWORD_RESET',
      'Use account recovery to change your own password.',
    )
  }

  const passwordHash = await hashPassword(input.password)
  return withTransaction(async (client) => {
    const existing = await userRepository.getUserById(client, userId)
    if (!existing) throw new AppError(404, 'USER_NOT_FOUND', 'The requested user was not found.')
    assertExistingAccountScope(existing, context.user)
    await userRepository.lockRole(client, existing.role_id)
    const existingRole = await userRepository.getRoleById(client, existing.role_id)
    assertExistingAccountPermissions(
      existingRole?.permissions ?? existing.permissions,
      context.user,
    )
    await userRepository.resetUserPassword(client, userId, passwordHash)
    await userRepository.insertUserAudit(client, {
      actorId: context.user.id,
      userId,
      action: 'reset user password',
      data: { sessionsRevoked: true },
      branchId: existing.branch_id,
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    })

    return { id: userId }
  })
}

async function assertAssignableRole(client: PoolClient, roleId: string, user: AuthenticatedUser) {
  await userRepository.lockRole(client, roleId)
  const role = await userRepository.getRoleById(client, roleId)
  if (!role) throw new AppError(404, 'ROLE_NOT_FOUND', 'Choose an existing role.')
  ensureCanGrantPermissions(role.permissions, user)
  return role
}

function assertCrossBranchRole(role: { is_system: number } | undefined, isCrossBranch: boolean) {
  if (isCrossBranch && role?.is_system !== 1) {
    throw new AppError(
      403,
      'ADMIN_ROLE_REQUIRED',
      'Company-wide access is reserved for the system Administrator role.',
    )
  }
  if (role?.is_system === 1 && !isCrossBranch) {
    throw new AppError(
      400,
      'ADMIN_GLOBAL_REQUIRED',
      'The system Administrator role must have company-wide access.',
    )
  }
}

function assertRoleAndBranchAssignment(
  role: { is_system: number } | undefined,
  branchId: string | null,
  isCrossBranch: boolean,
  actor: AuthenticatedUser,
) {
  if (actor.isCrossBranch) {
    assertCrossBranchRole(role, isCrossBranch)
    assertBranchAssignment(branchId, isCrossBranch, actor)
    return
  }

  assertBranchAssignment(branchId, isCrossBranch, actor)
  assertCrossBranchRole(role, isCrossBranch)
}

async function assertManageableRole(
  client: PoolClient,
  role: { id: string; permissions: string[] },
  actor: AuthenticatedUser,
) {
  ensureCanGrantPermissions(role.permissions, actor)
  const branchId = getAssignedBranchScope(actor)
  if (branchId && (await userRepository.hasRoleUsersOutsideBranch(client, role.id, branchId))) {
    throw new AppError(
      403,
      'ROLE_BRANCH_FORBIDDEN',
      'This role is assigned outside your branch. Ask an administrator with cross-branch access.',
    )
  }
}

function assertExistingAccountScope(
  account: { branch_id: string | null; is_cross_branch: number; is_system_role: number },
  actor: AuthenticatedUser,
) {
  const branchId = getAssignedBranchScope(actor)
  const isCrossBranch = account.is_cross_branch === 1 && account.is_system_role === 1
  if (branchId && (account.branch_id !== branchId || isCrossBranch)) {
    throw new AppError(404, 'USER_NOT_FOUND', 'The requested user was not found.')
  }
}

function assertExistingAccountPermissions(permissions: string[], actor: AuthenticatedUser) {
  if (permissions.some((key) => !actor.permissions.includes(key))) {
    throw new AppError(
      403,
      'ACCOUNT_PERMISSION_FORBIDDEN',
      'This account has permissions beyond your own. Ask an administrator with the required permissions.',
    )
  }
}

async function assertActiveBranch(
  client: PoolClient,
  branchId: string | null,
  isCrossBranch: boolean,
) {
  if (!branchId && isCrossBranch) return
  if (!branchId || !(await userRepository.isActiveBranch(client, branchId))) {
    throw new AppError(404, 'BRANCH_NOT_FOUND', 'Choose an active branch.')
  }
}

function assertBranchAssignment(
  branchId: string | null,
  isCrossBranch: boolean,
  actor: AuthenticatedUser,
) {
  if (isCrossBranch && !actor.isCrossBranch) {
    throw new AppError(403, 'BRANCH_FORBIDDEN', 'You cannot grant cross-branch access.')
  }
  if (!actor.isCrossBranch && (isCrossBranch || branchId !== actor.branchId)) {
    throw new AppError(
      403,
      'BRANCH_FORBIDDEN',
      'You can only manage users in your assigned branch.',
    )
  }
  if (!branchId && !isCrossBranch) {
    throw new AppError(
      400,
      'BRANCH_REQUIRED',
      'Assign this user to a branch or enable cross-branch access.',
    )
  }
}

function ensureCanGrantPermissions(permissions: string[], actor: AuthenticatedUser) {
  const forbiddenPermission = permissions.find(
    (permission) => !actor.permissions.includes(permission),
  )
  if (forbiddenPermission) {
    throw new AppError(
      403,
      'PERMISSION_ESCALATION',
      'You cannot assign permissions that your account does not have.',
      { permission: forbiddenPermission },
    )
  }
}

function hasConstraintCode(error: unknown, expectedCode: string): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === expectedCode
  )
}
