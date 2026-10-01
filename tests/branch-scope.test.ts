import { describe, expect, it } from 'vitest'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import { AppError } from '@/shared/errors/AppError.js'

describe('branch access scope', () => {
  it('returns the assigned branch for a branch-scoped account', () => {
    expect(
      getAssignedBranchScope({
        branchId: '00000000-0000-4000-8000-000000000001',
        isCrossBranch: false,
      }),
    ).toBe('00000000-0000-4000-8000-000000000001')
  })

  it('leaves cross-branch accounts unfiltered', () => {
    expect(getAssignedBranchScope({ branchId: null, isCrossBranch: true })).toBeUndefined()
  })

  it('denies branch-scoped data when a user has no branch assignment', () => {
    expect(() => getAssignedBranchScope({ branchId: null, isCrossBranch: false })).toThrowError(
      AppError,
    )
  })
})
