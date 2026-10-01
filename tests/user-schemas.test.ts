import { describe, expect, it } from 'vitest'
import {
  createRoleSchema,
  createUserSchema,
  resetUserPasswordSchema,
  updateUserSchema,
} from '@/features/users/user.schemas.js'

describe('user and role validation', () => {
  it('normalizes email and requires a strong initial password', () => {
    const result = createUserSchema.safeParse({
      name: 'Branch User',
      email: 'STAFF@EXAMPLE.COM',
      password: 'Strong-Init8',
      roleId: '00000000-0000-4000-8000-000000000001',
      branchId: '00000000-0000-4000-8000-000000000002',
    })

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.email).toBe('staff@example.com')

    const weakPassword = createUserSchema.safeParse({
      name: 'Branch User',
      email: 'staff@example.com',
      password: 'short',
      roleId: '00000000-0000-4000-8000-000000000001',
      branchId: '00000000-0000-4000-8000-000000000002',
    })
    expect(weakPassword.success).toBe(false)
  })

  it('rejects unknown and duplicate role permissions', () => {
    const unknownPermission = createRoleSchema.safeParse({
      name: 'Inventory Staff',
      permissions: ['inventory.read', 'system.root'],
    })
    const duplicatePermission = createRoleSchema.safeParse({
      name: 'Inventory Staff',
      permissions: ['inventory.read', 'inventory.read'],
    })

    expect(unknownPermission.success).toBe(false)
    expect(duplicatePermission.success).toBe(false)
  })

  it('requires at least one recognized field for user updates', () => {
    expect(updateUserSchema.safeParse({}).success).toBe(false)
    expect(updateUserSchema.safeParse({ status: 'Suspended' }).success).toBe(false)
    expect(updateUserSchema.safeParse({ status: 'Inactive' }).success).toBe(true)
  })

  it('requires a strong password for administrative resets', () => {
    expect(resetUserPasswordSchema.safeParse({ password: 'short' }).success).toBe(false)
    expect(resetUserPasswordSchema.safeParse({ password: 'Strong-Reset8!' }).success).toBe(true)
    expect(
      resetUserPasswordSchema.safeParse({
        password: 'Strong-Reset8!',
        email: 'ignored@example.com',
      }).success,
    ).toBe(false)
  })

  it('requires at least 8 characters and all four character classes', () => {
    const base = {
      name: 'Branch User',
      email: 'staff@example.com',
      roleId: '00000000-0000-4000-8000-000000000001',
      branchId: '00000000-0000-4000-8000-000000000002',
    }
    for (const password of [
      'Ab1!',
      'lowercase1!',
      'UPPERCASE1!',
      'NoNumber!!',
      'MissingSpecial8',
    ]) {
      expect(createUserSchema.safeParse({ ...base, password }).success, password).toBe(false)
      expect(resetUserPasswordSchema.safeParse({ password }).success, password).toBe(false)
    }
    for (const password of ['Abcdef1!', 'Xy8$abcd']) {
      expect(createUserSchema.safeParse({ ...base, password }).success, password).toBe(true)
      expect(resetUserPasswordSchema.safeParse({ password }).success, password).toBe(true)
    }
    expect(createUserSchema.safeParse({ ...base, password: `${'A'.repeat(126)}a1!` }).success).toBe(
      false,
    )
  })
})
