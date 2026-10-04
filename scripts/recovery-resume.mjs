export function validateRecoveryResumeCheckpoint({
  expectedMigrationTimestamps,
  appliedMigrationTimestamps,
  attachments,
  proofs,
}) {
  if (
    !Array.isArray(expectedMigrationTimestamps) ||
    expectedMigrationTimestamps.length < 2 ||
    expectedMigrationTimestamps.some((timestamp) => !Number.isSafeInteger(timestamp)) ||
    !Array.isArray(appliedMigrationTimestamps) ||
    appliedMigrationTimestamps.length !== expectedMigrationTimestamps.length - 1 ||
    appliedMigrationTimestamps.some(
      (timestamp, index) => timestamp !== expectedMigrationTimestamps[index],
    )
  ) {
    throw new Error(
      'The recovery database is not at the supported interrupted-migration checkpoint.',
    )
  }

  const expectedAttachments = [...proofs]
    .map((proof) => ({
      objectKey: proof.sourceKey,
      fileSize: proof.fileSize,
      mimeType: proof.mimeType,
    }))
    .sort((left, right) => left.objectKey.localeCompare(right.objectKey))
  const actualAttachments = [...attachments]
    .map((attachment) => ({
      objectKey: attachment.objectKey,
      fileSize: Number(attachment.fileSize),
      mimeType: attachment.mimeType,
    }))
    .sort((left, right) => left.objectKey.localeCompare(right.objectKey))

  if (
    actualAttachments.length !== expectedAttachments.length ||
    expectedAttachments.some((expected, index) => {
      const actual = actualAttachments[index]
      return (
        actual.objectKey !== expected.objectKey ||
        actual.fileSize !== expected.fileSize ||
        actual.mimeType !== expected.mimeType
      )
    })
  ) {
    throw new Error(
      'The recovery database attachment map differs from the selected backup manifest.',
    )
  }
}
