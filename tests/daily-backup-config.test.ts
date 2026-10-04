import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  approvedRecoveryBucket,
  getArchivedProofKey,
  getDailyBackupPaths,
  getRestoreConfirmation,
  validateDailyBackupManifest,
} from '../scripts/daily-backup-paths.mjs'

describe('staging daily backup target rules', () => {
  it('uses the configured recovery Neon host secret in validation and restore', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/restore-scheduled-staging-backup.yml', import.meta.url),
      'utf8',
    )

    expect(workflow).toContain(
      'RECOVERY_REHEARSAL_NEON_HOST: ${{ secrets.RECOVERY_REHEARSAL_NEON_HOST }}',
    )
    expect(workflow).toContain(
      'RECOVERY_DATABASE_HOST: ${{ secrets.RECOVERY_REHEARSAL_NEON_HOST }}',
    )
    expect(workflow).not.toContain('vars.RECOVERY_REHEARSAL_NEON_HOST')
  })

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

  it('binds a restore confirmation and manifest to one run, attempt, and target database', () => {
    const paths = getDailyBackupPaths('37155345138', '1')
    const manifest = {
      format: 'cbms-staging-backup-manifest-v1',
      runId: '37155345138',
      runAttempt: '1',
      createdAt: '2026-10-04T21:31:33.765Z',
      snapshotAt: '2026-10-04T21:30:12.000Z',
      retentionDays: 30,
      databaseBackup: {
        key: paths.databaseBackupKey,
        size: 141678,
        sha256: 'a'.repeat(64),
      },
      proofs: [
        {
          sourceKey: 'r2/614c55f9-f86e-4047-b91f-f2e1ba971c28',
          archivedKey: getArchivedProofKey(
            '37155345138',
            '1',
            'r2/614c55f9-f86e-4047-b91f-f2e1ba971c28',
          ),
          fileSize: 633,
          mimeType: 'application/pdf',
          sha256: 'b'.repeat(64),
        },
      ],
    }

    expect(getRestoreConfirmation('37155345138', '1', 'neondb')).toBe(
      'RESTORE-37155345138-ATTEMPT-1-TO-neondb',
    )
    expect(getRestoreConfirmation('37155345138', '1', 'cbms_recovery_rehearsal', 'resume')).toBe(
      'RESUME-RESTORE-37155345138-ATTEMPT-1-TO-cbms_recovery_rehearsal',
    )
    expect(() => getRestoreConfirmation('37155345138', '1', 'neondb', 'replace')).toThrow(
      'supported recovery mode',
    )
    expect(validateDailyBackupManifest(manifest, '37155345138', '1')).toBe(manifest)
    expect(() => getRestoreConfirmation('37155345138', '1', '../production')).toThrow(
      'safe recovery database name',
    )
    expect(() => validateDailyBackupManifest(manifest, '37155345138', '2')).toThrow(
      'does not match the requested run and attempt',
    )
  })

  it('rejects duplicate proof mappings in a daily backup manifest', () => {
    const paths = getDailyBackupPaths('2002', '1')
    const proof = {
      sourceKey: 'r2/614c55f9-f86e-4047-b91f-f2e1ba971c28',
      archivedKey: getArchivedProofKey('2002', '1', 'r2/614c55f9-f86e-4047-b91f-f2e1ba971c28'),
      fileSize: 633,
      mimeType: 'application/pdf',
      sha256: 'c'.repeat(64),
    }
    const manifest = {
      format: 'cbms-staging-backup-manifest-v1',
      runId: '2002',
      runAttempt: '1',
      createdAt: '2026-10-04T21:31:33.765Z',
      retentionDays: 30,
      databaseBackup: { key: paths.databaseBackupKey, size: 1, sha256: 'd'.repeat(64) },
      proofs: [proof, proof],
    }

    expect(() => validateDailyBackupManifest(manifest, '2002', '1')).toThrow('invalid proof entry')
  })

  it('rejects manifests without a valid database snapshot timestamp', () => {
    const paths = getDailyBackupPaths('2003', '1')
    const manifest = {
      format: 'cbms-staging-backup-manifest-v1',
      runId: '2003',
      runAttempt: '1',
      createdAt: '2026-10-04T21:31:33.765Z',
      snapshotAt: 'not-a-timestamp',
      retentionDays: 30,
      databaseBackup: { key: paths.databaseBackupKey, size: 1, sha256: 'e'.repeat(64) },
      proofs: [],
    }

    expect(() => validateDailyBackupManifest(manifest, '2003', '1')).toThrow(
      'does not match the requested run and attempt',
    )
  })
})
