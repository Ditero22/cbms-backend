import { describe, expect, it } from 'vitest'
import {
  expectedSampleEmployeeCounts,
  hasExpectedSampleEmployeeDistribution,
  isCompatibleSamplePayrollEntryCount,
} from '../src/database/sample-data-rules.js'

describe('sample employee fixtures', () => {
  it('requires a manager, staff member, five drivers, five site workers, and one laborer per branch', () => {
    const positions = [
      'Branch Manager',
      'Staff',
      ...Array.from({ length: 5 }, () => 'Driver'),
      ...Array.from({ length: 5 }, () => 'Site Worker'),
      'Laborer',
    ]

    expect(expectedSampleEmployeeCounts.total).toBe(39)
    expect(hasExpectedSampleEmployeeDistribution(positions)).toBe(true)
    expect(hasExpectedSampleEmployeeDistribution(positions.slice(1))).toBe(false)
    expect(hasExpectedSampleEmployeeDistribution([...positions, 'Laborer'])).toBe(false)
  })

  it('preserves previously seeded twelve-entry payroll runs without accepting arbitrary counts', () => {
    expect(isCompatibleSamplePayrollEntryCount(12)).toBe(true)
    expect(isCompatibleSamplePayrollEntryCount(13)).toBe(true)
    expect(isCompatibleSamplePayrollEntryCount(11)).toBe(false)
    expect(isCompatibleSamplePayrollEntryCount(14)).toBe(false)
  })
})
