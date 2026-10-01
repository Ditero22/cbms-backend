import { describe, expect, it } from 'vitest'
import {
  createEmployeeSchema,
  updateEmployeeSchema,
} from '@/features/employees/employee.schemas.js'

const employee = {
  employeeNumber: 'EMP-104',
  name: 'Jordan Lee',
  position: 'Site Manager',
  branchId: '8d6f1ff0-9d4f-45f6-8a0a-3e01a9009e41',
  email: 'jordan@example.com',
  phone: '+63 917 555 0104',
}

describe('employee input validation', () => {
  it('accepts valid create details and optional contact information', () => {
    expect(createEmployeeSchema.parse(employee)).toEqual(employee)
    expect(
      createEmployeeSchema.safeParse({
        ...employee,
        email: '',
        phone: undefined,
      }).success,
    ).toBe(true)
    expect(createEmployeeSchema.parse({ ...employee, hiredAt: '2026-09-01' }).hiredAt).toBe(
      '2026-09-01',
    )
  })

  it('rejects malformed email, branch identifiers, and unknown fields', () => {
    expect(createEmployeeSchema.safeParse({ ...employee, email: 'bad-address' }).success).toBe(
      false,
    )
    expect(createEmployeeSchema.safeParse({ ...employee, branchId: 'branch-1' }).success).toBe(
      false,
    )
    expect(createEmployeeSchema.safeParse({ ...employee, salary: '1000' }).success).toBe(false)
    expect(createEmployeeSchema.safeParse({ ...employee, hiredAt: 'September 1' }).success).toBe(
      false,
    )
  })

  it('requires a valid non-empty update and constrains status values', () => {
    expect(updateEmployeeSchema.safeParse({}).success).toBe(false)
    expect(updateEmployeeSchema.parse({ status: 'Inactive' })).toEqual({ status: 'Inactive' })
    expect(updateEmployeeSchema.safeParse({ status: 'Deleted' }).success).toBe(false)
    expect(updateEmployeeSchema.parse({ hiredAt: null })).toEqual({ hiredAt: null })
  })
})
