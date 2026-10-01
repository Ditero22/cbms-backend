import { describe, expect, it } from 'vitest'
import { createSchemas } from '@/features/records/record-schemas.js'
import { updateRecordSchemas } from '@/features/records/record-lifecycle.schemas.js'
import { createEmployeeSchema } from '@/features/employees/employee.schemas.js'

describe('operational master record validation', () => {
  it('allows omitted, unassigned, or valid customer branches without accepting malformed values', () => {
    const customer = { name: 'Branch choice customer' }
    expect(createSchemas.customers!.safeParse(customer).success).toBe(true)
    expect(createSchemas.customers!.safeParse({ ...customer, branchId: null }).success).toBe(true)
    expect(
      createSchemas.customers!.safeParse({
        ...customer,
        branchId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(true)
    for (const branchId of ['', 'unassigned', 'not-a-uuid', true, 1]) {
      expect(
        createSchemas.customers!.safeParse({ ...customer, branchId }).success,
        String(branchId),
      ).toBe(false)
    }
  })

  it('accepts optional contact and material information without forcing it on old records', () => {
    expect(createSchemas.branches!.safeParse({ name: 'Legacy yard', code: 'LEGACY' }).success).toBe(
      true,
    )
    expect(
      createEmployeeSchema.safeParse({
        employeeNumber: 'OLD-1',
        name: 'Existing worker',
        position: 'Mason',
        branchId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(true)
    expect(
      createSchemas.products!.safeParse({
        name: 'Existing material',
        sku: 'OLD-1',
        category: 'Materials',
        unit: 'bag',
        unitPrice: '0',
      }).success,
    ).toBe(true)
    expect(
      createSchemas.branches!.safeParse({
        name: 'Service yard',
        code: 'YARD',
        email: 'yard@example.invalid',
      }).success,
    ).toBe(true)
    expect(
      createEmployeeSchema.safeParse({
        employeeNumber: 'W-1',
        name: 'Site worker',
        position: 'Mason',
        branchId: '00000000-0000-4000-8000-000000000001',
        address: 'Service district',
      }).success,
    ).toBe(true)
    expect(
      createSchemas.products!.safeParse({
        name: 'Cement',
        sku: 'CEM-1',
        category: 'Cement',
        unit: 'bag',
        unitPrice: '250.00',
        description: '40 kg bag',
      }).success,
    ).toBe(true)
  })

  it('rejects malformed branch contact and overlong operational fields', () => {
    expect(
      createSchemas.branches!.safeParse({ name: 'Service yard', code: 'YARD', email: 'invalid' })
        .success,
    ).toBe(false)
    expect(updateRecordSchemas.branches.safeParse({ email: 'invalid' }).success).toBe(false)
    expect(updateRecordSchemas.products.safeParse({ description: 'x'.repeat(2001) }).success).toBe(
      false,
    )
  })

  it('rejects ambiguous product price coercions and retains exact supported money', () => {
    const product = { name: 'Cement', sku: 'CEM-1', category: 'Cement', unit: 'bag' }
    for (const unitPrice of ['', ' ', true, null, '1e2', '12.345', '-1']) {
      expect(
        createSchemas.products!.safeParse({ ...product, unitPrice }).success,
        String(unitPrice),
      ).toBe(false)
    }
    for (const unitPrice of ['0', '250.05', '999999999999.99', 250.05]) {
      expect(
        createSchemas.products!.safeParse({ ...product, unitPrice }).success,
        String(unitPrice),
      ).toBe(true)
    }
  })
})
