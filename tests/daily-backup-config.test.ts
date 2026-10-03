import { describe, expect, it } from 'vitest'
import {
  approvedRecoveryBucket,
  getArchivedProofKey,
  getDailyBackupPaths,
} from '../scripts/daily-backup-paths.mjs'

describe('staging daily backup target rules', () => {
  it('keeps proof snapshots unique per workflow run under the 30-day lifecycle prefix', () => {
    const runA = getDailyBackupPaths('1001', '1')
    const runB = getDailyBackupPaths('1001', '2')

    expect(runA.proofPrefix).toBe('r2/staging-backups/1001-attempt-1')
    expect(runA.databaseBackupKey).toBe('cbms-recovery/backups/staging-1001-attempt-1.dump.enc')
    expect(runA.manifestKey).toBe('cbms-recovery/backups/staging-1001-attempt-1.manifest.json')
    expect(runA).not.toEqual(runB)
    expect(getArchivedProofKey('1001', '1', 'r2/614c55f9-f86e-4047-b91f-f2e1ba971c28')).toBe(
      'r2/staging-backups/1001-attempt-1/614c55f9-f86e-4047-b91f-f2e1ba971c28',
    )
    expect(approvedRecoveryBucket).toBe('cbms-recovery-storage')
  })

  it('rejects unsafe run identifiers and proof keys before writing recovery objects', () => {
    expect(() => getDailyBackupPaths('../other')).toThrow('Numeric workflow run and attempt IDs')
    expect(() => getDailyBackupPaths('1001', '../other')).toThrow(
      'Numeric workflow run and attempt IDs',
    )
    expect(() => getArchivedProofKey('1001', '1', 'r2/../../other')).toThrow(
      'supported private staging proof keys',
    )
  })
})
