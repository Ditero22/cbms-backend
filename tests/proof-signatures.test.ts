import { describe, expect, it } from 'vitest'
import { hasProofSignature, proofEntitySchema } from '@/features/attachments/attachment.schemas.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=',
  'base64',
)

describe('private proof validation', () => {
  it('recognizes a PNG with image metadata and an end chunk', () => {
    expect(hasProofSignature(png, 'image/png')).toBe(true)
    expect(hasProofSignature(png, 'image/jpeg')).toBe(false)
    expect(hasProofSignature(png, 'application/octet-stream')).toBe(false)
  })

  it('rejects executables, spoofed headers and truncated supported formats', () => {
    expect(hasProofSignature(Buffer.from('MZ executable'), 'image/png')).toBe(false)
    expect(hasProofSignature(png.subarray(0, 8), 'image/png')).toBe(false)
    expect(hasProofSignature(png.subarray(0, -12), 'image/png')).toBe(false)
    expect(hasProofSignature(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg')).toBe(false)
    expect(hasProofSignature(Buffer.from('RIFF0000WEBP'), 'image/webp')).toBe(false)
    expect(hasProofSignature(Buffer.from('%PDF-1.4 without end marker'), 'application/pdf')).toBe(
      false,
    )
  })

  it('accepts bounded PDF signatures and rejects unsupported financial parent concepts', () => {
    expect(
      hasProofSignature(Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF'), 'application/pdf'),
    ).toBe(true)
    const id = '00000000-0000-4000-8000-000000000001'
    expect(proofEntitySchema.safeParse({ entityType: 'payment', entityId: id }).success).toBe(true)
    expect(proofEntitySchema.safeParse({ entityType: 'users', entityId: id }).success).toBe(false)
    expect(
      proofEntitySchema.safeParse({
        entityType: 'payment',
        entityId: id,
        objectKey: 'local/private',
      }).success,
    ).toBe(false)
  })
})
