import { describe, expect, it } from 'vitest'
import { validateRecoveryResumeCheckpoint } from '../scripts/recovery-resume.mjs'

const migrationTimestamps = [1735689600000, 1735776000000, 1735862400000, 1735948800000]

const proofs = [
  {
    sourceKey: 'r2/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    fileSize: 633,
    mimeType: 'application/pdf',
  },
  {
    sourceKey: 'r2/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    fileSize: 658,
    mimeType: 'image/png',
  },
]

const attachments = proofs.map((proof) => ({
  objectKey: proof.sourceKey,
  fileSize: String(proof.fileSize),
  mimeType: proof.mimeType,
}))

describe('recovery resume checkpoint validation', () => {
  it('accepts only the exact expected migration prefix and matching proof metadata', () => {
    expect(() =>
      validateRecoveryResumeCheckpoint({
        expectedMigrationTimestamps: migrationTimestamps,
        appliedMigrationTimestamps: migrationTimestamps.slice(0, -1),
        attachments,
        proofs,
      }),
    ).not.toThrow()
  })

  it.each([
    ['already fully migrated', migrationTimestamps],
    ['missing an earlier migration', [migrationTimestamps[0], migrationTimestamps[2]]],
    ['applied an unexpected migration', [migrationTimestamps[0], migrationTimestamps[1], 42]],
  ])('rejects a target that is %s', (_label, appliedMigrationTimestamps) => {
    expect(() =>
      validateRecoveryResumeCheckpoint({
        expectedMigrationTimestamps: migrationTimestamps,
        appliedMigrationTimestamps,
        attachments,
        proofs,
      }),
    ).toThrow('supported interrupted-migration checkpoint')
  })

  it.each([
    ['has a missing proof row', attachments.slice(0, 1)],
    ['has an unexpected proof row', [...attachments, { ...attachments[0], objectKey: 'r2/extra' }]],
    ['has a different key', [{ ...attachments[0], objectKey: 'r2/other' }, attachments[1]]],
    ['has a different size', [{ ...attachments[0], fileSize: '634' }, attachments[1]]],
    ['has a different MIME type', [{ ...attachments[0], mimeType: 'image/png' }, attachments[1]]],
  ])('rejects when the attachment map %s', (_label, attachmentRows) => {
    expect(() =>
      validateRecoveryResumeCheckpoint({
        expectedMigrationTimestamps: migrationTimestamps,
        appliedMigrationTimestamps: migrationTimestamps.slice(0, -1),
        attachments: attachmentRows,
        proofs,
      }),
    ).toThrow('attachment map differs')
  })
})
