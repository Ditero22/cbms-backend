import { Router } from 'express'
import {
  createRole,
  createUser,
  deleteUserAccount,
  deleteRole,
  getRolePermissionOptions,
  getUserOptions,
  listRoles,
  resetUserPassword,
  updateRole,
  updateUser,
} from '@/features/users/user.service.js'
import {
  createRoleSchema,
  createUserSchema,
  resetUserPasswordSchema,
  updateRoleSchema,
  updateUserSchema,
} from '@/features/users/user.schemas.js'
import { AppError } from '@/shared/errors/AppError.js'
import { z } from 'zod'
import { getRoleDetail, getUserDetail } from '@/features/users/user-detail.service.js'

export const userManagementRouter = Router()

userManagementRouter.get('/users/options', async (req, res) => {
  const user = req.user
  if (
    !user ||
    (!user.permissions.includes('users.create') && !user.permissions.includes('users.update'))
  ) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to manage users.')
  }

  res.json(await getUserOptions(user))
})

userManagementRouter.post('/users', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('users.create')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to create users.')
  }

  const parsed = createUserSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Check the user account values.',
      parsed.error.flatten(),
    )
  }

  const createdUser = await createUser(parsed.data, {
    user,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })
  res.status(201).json(createdUser)
})

userManagementRouter.get('/users/:userId', async (req, res) => {
  if (!req.user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  res.json(
    await getUserDetail(parseRecordId(req.params.userId), req.user, parseHistoryPage(req.query)),
  )
})

userManagementRouter.patch('/users/:userId', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('users.update')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to update users.')
  }

  const parsed = updateUserSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Check the user account values.',
      parsed.error.flatten(),
    )
  }

  const updatedUser = await updateUser(parseRecordId(req.params.userId), parsed.data, {
    user,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })
  res.json(updatedUser)
})

userManagementRouter.delete('/users/:userId', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('users.update')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to delete user accounts.')
  }

  const deletedUser = await deleteUserAccount(parseRecordId(req.params.userId), {
    user,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })
  res.json(deletedUser)
})

userManagementRouter.post('/users/:userId/password', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('users.update')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to reset user passwords.')
  }

  const parsed = resetUserPasswordSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Password must be 8–128 characters and include uppercase and lowercase letters, a number, and a special character.',
      parsed.error.flatten(),
    )
  }

  const reset = await resetUserPassword(parseRecordId(req.params.userId), parsed.data, {
    user,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })
  res.json(reset)
})

userManagementRouter.get('/roles', async (req, res) => {
  if (!req.user?.permissions.includes('roles.read')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view roles.')
  }

  res.json(await listRoles(req.user))
})

userManagementRouter.get('/roles/options', async (req, res) => {
  const user = req.user
  if (
    !user ||
    (!user.permissions.includes('roles.read') &&
      !user.permissions.includes('roles.create') &&
      !user.permissions.includes('roles.update'))
  ) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to manage roles.')
  }

  res.json(getRolePermissionOptions(user))
})

userManagementRouter.post('/roles', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('roles.create')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to create roles.')
  }

  const parsed = createRoleSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the role values.', parsed.error.flatten())
  }

  const role = await createRole(parsed.data, {
    user,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })
  res.status(201).json(role)
})

userManagementRouter.get('/roles/:roleId', async (req, res) => {
  if (!req.user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  res.json(
    await getRoleDetail(parseRecordId(req.params.roleId), req.user, parseHistoryPage(req.query)),
  )
})

userManagementRouter.patch('/roles/:roleId', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('roles.update')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to update roles.')
  }

  const parsed = updateRoleSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the role values.', parsed.error.flatten())
  }

  const role = await updateRole(parseRecordId(req.params.roleId), parsed.data, {
    user,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })
  res.json(role)
})

userManagementRouter.delete('/roles/:roleId', async (req, res) => {
  const user = req.user
  if (!user?.permissions.includes('roles.update')) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to delete roles.')
  }

  const role = await deleteRole(parseRecordId(req.params.roleId), {
    user,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })
  res.json(role)
})

function parseRecordId(value: string | undefined) {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success) throw new AppError(400, 'INVALID_RECORD_ID', 'The record ID is invalid.')
  return parsed.data
}

function parseHistoryPage(value: unknown) {
  const parsed = z
    .object({ historyPage: z.coerce.number().int().min(1).max(10000).optional() })
    .strict()
    .safeParse(value)
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'The history page is invalid.')
  return parsed.data.historyPage ?? 1
}
