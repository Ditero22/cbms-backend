import { z } from 'zod'
import { permissionKeys } from '@/database/permissions.js'
import { passwordSchema } from '@/shared/security/password-policy.js'

const permissionSchema = z.enum(permissionKeys as [string, ...string[]])

const uniquePermissions = (permissions: string[], context: z.RefinementCtx) => {
  if (new Set(permissions).size !== permissions.length) {
    context.addIssue({ code: 'custom', message: 'Permissions must not contain duplicates.' })
  }
}

export const createRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(240).optional(),
    permissions: z.array(permissionSchema).max(permissionKeys.length),
  })
  .strict()
  .superRefine((value, context) => uniquePermissions(value.permissions, context))

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(240).nullable().optional(),
    permissions: z.array(permissionSchema).max(permissionKeys.length).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one role value is required.')
  .superRefine((value, context) => {
    if (value.permissions) uniquePermissions(value.permissions, context)
  })

export const createUserSchema = z
  .object({
    name: z.string().trim().min(2).max(180),
    email: z.email().trim().toLowerCase(),
    password: passwordSchema,
    roleId: z.uuid(),
    branchId: z.uuid().nullable(),
    isCrossBranch: z.boolean().default(false),
  })
  .strict()

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(180).optional(),
    roleId: z.uuid().optional(),
    branchId: z.uuid().nullable().optional(),
    isCrossBranch: z.boolean().optional(),
    status: z.enum(['Active', 'Inactive']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one user value is required.')

export const resetUserPasswordSchema = z
  .object({
    password: passwordSchema,
  })
  .strict()

export type CreateRoleInput = z.infer<typeof createRoleSchema>
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>
export type CreateUserInput = z.infer<typeof createUserSchema>
export type UpdateUserInput = z.infer<typeof updateUserSchema>
export type ResetUserPasswordInput = z.infer<typeof resetUserPasswordSchema>
