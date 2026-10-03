export const approvedRecoveryBucket = 'cbms-recovery-storage'

export function getDailyBackupPaths(runId, runAttempt = '1') {
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(runAttempt))
    throw new Error('Numeric workflow run and attempt IDs are required.')
  const snapshotId = `${runId}-attempt-${runAttempt}`
  return {
    databaseBackupKey: `cbms-recovery/backups/staging-${snapshotId}.dump.enc`,
    manifestKey: `cbms-recovery/backups/staging-${snapshotId}.manifest.json`,
    proofPrefix: `r2/staging-backups/${snapshotId}`,
  }
}

export function getArchivedProofKey(runId, runAttempt, objectKey) {
  const { proofPrefix } = getDailyBackupPaths(runId, runAttempt)
  if (!/^r2\/[a-f0-9-]{36}$/.test(objectKey))
    throw new Error('Only supported private staging proof keys can be archived.')
  return `${proofPrefix}/${objectKey.slice('r2/'.length)}`
}
