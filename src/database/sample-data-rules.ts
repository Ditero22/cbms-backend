export const expectedSampleEmployeeCounts = {
  perBranch: 13,
  total: 39,
  positions: {
    'Branch Manager': 1,
    Staff: 1,
    Driver: 5,
    'Site Worker': 5,
    Laborer: 1,
  },
} as const

export type SampleEmployeePosition = keyof typeof expectedSampleEmployeeCounts.positions

export function hasExpectedSampleEmployeeDistribution(
  positions: readonly string[],
): positions is readonly SampleEmployeePosition[] {
  if (positions.length !== expectedSampleEmployeeCounts.perBranch) return false

  return Object.entries(expectedSampleEmployeeCounts.positions).every(
    ([position, expectedCount]) =>
      positions.filter((value) => value === position).length === expectedCount,
  )
}

export function isCompatibleSamplePayrollEntryCount(count: number) {
  // Preserve existing twelve-entry payroll runs created by the earlier sample cohort.
  return (
    count === expectedSampleEmployeeCounts.perBranch - 1 ||
    count === expectedSampleEmployeeCounts.perBranch
  )
}
