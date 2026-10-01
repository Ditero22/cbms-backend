import { createHash } from 'node:crypto'
import { AppError } from '@/shared/errors/AppError.js'
import { hasProofSignature, maxProofBytes, proofMimeTypes } from './attachment.schemas.js'

export type ValidatedProof = { fileName: string; mimeType: string; bytes: Buffer; hash: string }

export function validateProofInput(
  fileName: string,
  mimeType: string,
  bytes: unknown,
  imagesOnly = false,
): ValidatedProof {
  const hasControlCharacter = Array.from(fileName).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  )
  if (!fileName || fileName.length > 180 || /[/\\]/.test(fileName) || hasControlCharacter)
    throw new AppError(
      400,
      'INVALID_PROOF_NAME',
      'Use a file name without paths or control characters, up to 180 characters.',
    )
  if (
    !proofMimeTypes.some((type) => type === mimeType) ||
    (imagesOnly && !mimeType.startsWith('image/')) ||
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > maxProofBytes ||
    !hasProofSignature(bytes, mimeType)
  )
    throw new AppError(
      400,
      'INVALID_PROOF_FILE',
      imagesOnly
        ? 'Upload a valid JPEG, PNG, or WebP image up to 10 MB.'
        : 'Upload a valid JPEG, PNG, WebP, or PDF file up to 10 MB.',
    )
  const extension = fileName.split('.').at(-1)?.toLowerCase()
  const extensions: Record<string, string[]> = {
    'image/jpeg': ['jpg', 'jpeg'],
    'image/png': ['png'],
    'image/webp': ['webp'],
    'application/pdf': ['pdf'],
  }
  if (!extension || !extensions[mimeType]?.includes(extension))
    throw new AppError(400, 'INVALID_PROOF_EXTENSION', 'The file extension must match its type.')
  return { fileName, mimeType, bytes, hash: createHash('sha256').update(bytes).digest('hex') }
}
