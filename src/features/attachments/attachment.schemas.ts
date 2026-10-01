import { z } from 'zod'

export const proofEntitySchema = z
  .object({
    entityType: z.enum(['vehicle-maintenance', 'driver-allowance', 'payment', 'payroll-entry']),
    entityId: z.uuid(),
  })
  .strict()

export type ProofEntity = z.infer<typeof proofEntitySchema>
export const maxProofBytes = 10 * 1024 * 1024

export const proofMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const

export function hasProofSignature(bytes: Buffer, mimeType: string) {
  if (mimeType === 'image/jpeg')
    return (
      bytes.length >= 12 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff &&
      bytes.at(-2) === 0xff &&
      bytes.at(-1) === 0xd9
    )
  if (mimeType === 'image/png')
    return (
      bytes.length >= 45 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.readUInt32BE(8) === 13 &&
      bytes.toString('ascii', 12, 16) === 'IHDR' &&
      bytes.readUInt32BE(16) > 0 &&
      bytes.readUInt32BE(20) > 0 &&
      bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND'
    )
  if (mimeType === 'image/webp')
    return (
      bytes.length >= 20 &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP' &&
      bytes.readUInt32LE(4) + 8 === bytes.length &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))
    )
  if (mimeType === 'application/pdf')
    return (
      bytes.length >= 8 &&
      bytes.toString('ascii', 0, 5) === '%PDF-' &&
      bytes.subarray(-1024).includes(Buffer.from('%%EOF'))
    )
  return false
}
