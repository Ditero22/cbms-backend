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

export function getRestoreConfirmation(runId, runAttempt, databaseName) {
  getDailyBackupPaths(runId, runAttempt)
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(databaseName))
    throw new Error('A safe recovery database name is required.')
  return `RESTORE-${runId}-ATTEMPT-${runAttempt}-TO-${databaseName}`
}

export function validateDailyBackupManifest(manifest, runId, runAttempt, retentionDays = 30) {
  const paths = getDailyBackupPaths(runId, runAttempt)
  const createdAt = Date.parse(manifest?.createdAt)
  const snapshotAt = manifest?.snapshotAt === undefined ? null : Date.parse(manifest.snapshotAt)
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.format !== 'cbms-staging-backup-manifest-v1' ||
    manifest.runId !== runId ||
    manifest.runAttempt !== runAttempt ||
    manifest.retentionDays !== retentionDays ||
    !Number.isFinite(createdAt) ||
    (manifest.snapshotAt !== undefined &&
      (!Number.isFinite(snapshotAt) || snapshotAt > createdAt)) ||
    manifest.databaseBackup?.key !== paths.databaseBackupKey ||
    !Number.isSafeInteger(manifest.databaseBackup?.size) ||
    manifest.databaseBackup.size < 1 ||
    !/^[a-f0-9]{64}$/.test(manifest.databaseBackup?.sha256 ?? '') ||
    !Array.isArray(manifest.proofs) ||
    manifest.proofs.length > 100
  )
    throw new Error('The backup manifest does not match the requested run and attempt.')

  const seen = new Set()
  let totalProofBytes = 0
  for (const proof of manifest.proofs) {
    const expectedArchivedKey = getArchivedProofKey(runId, runAttempt, proof?.sourceKey ?? '')
    if (
      proof.archivedKey !== expectedArchivedKey ||
      seen.has(proof.sourceKey) ||
      !Number.isSafeInteger(proof.fileSize) ||
      proof.fileSize < 0 ||
      proof.fileSize > 10 * 1024 * 1024 ||
      typeof proof.mimeType !== 'string' ||
      proof.mimeType.length < 1 ||
      proof.mimeType.length > 100 ||
      !/^[a-f0-9]{64}$/.test(proof.sha256 ?? '')
    )
      throw new Error('The backup manifest contains an invalid proof entry.')
    seen.add(proof.sourceKey)
    totalProofBytes += proof.fileSize
    if (totalProofBytes > 100 * 1024 * 1024)
      throw new Error('The backup manifest exceeds the supported proof archive size.')
  }

  return manifest
}
