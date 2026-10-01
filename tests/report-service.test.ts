import { describe, expect, it } from 'vitest'
import { requireReportAccess } from '@/features/reports/reports.access.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'

function makeUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Branch reviewer',
    email: 'reviewer@example.invalid',
    role: 'Reviewer',
    branchId: '00000000-0000-4000-8000-000000000002',
    branch: 'North',
    isCrossBranch: false,
    permissions: ['reports.view'],
    ...overrides,
  }
}

describe('report permissions and branch scope', () => {
  it('requires report viewing permission before querying data', () => {
    expect(() => requireReportAccess(makeUser({ permissions: [] }))).toThrowError(
      'You do not have permission to view reports.',
    )
  })

  it('requires a separate permission for downloads', () => {
    expect(() => requireReportAccess(makeUser(), true)).toThrowError(
      'You do not have permission to export reports.',
    )
  })

  it('fails closed for branch-scoped users without a branch assignment', () => {
    expect(() =>
      requireReportAccess(makeUser({ branchId: null, permissions: ['reports.view'] })),
    ).toThrowError('Assign this account to a branch before accessing branch-scoped data.')
  })
})
