import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { env } from '@/config/env.js'
import { AppError } from '@/shared/errors/AppError.js'
import { maxProofBytes } from './attachment.schemas.js'

const localRoot = path.resolve(env.localUploadDir)
const r2Client = env.r2.enabled
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: env.r2.accessKeyId, secretAccessKey: env.r2.secretAccessKey },
    })
  : null

function validateKey(key: string) {
  if (!/^(local|r2)\/[a-f0-9-]{36}$/.test(key))
    throw new AppError(404, 'PROOF_NOT_FOUND', 'Proof not found.')
  return key.split('/')[1]!
}

export function createProofKey() {
  return `${r2Client ? 'r2' : 'local'}/${randomUUID()}`
}

export async function saveProof(bytes: Buffer, mimeType: string, key = createProofKey()) {
  const id = validateKey(key)
  if (r2Client) {
    await r2Client.send(
      new PutObjectCommand({
        Bucket: env.r2.bucketName,
        Key: key,
        Body: bytes,
        ContentType: mimeType,
      }),
    )
    return key
  }
  if (env.isProduction)
    throw new AppError(
      503,
      'PRIVATE_STORAGE_REQUIRED',
      'Private proof storage has not been configured.',
    )
  await mkdir(localRoot, { recursive: true, mode: 0o700 })
  await writeFile(path.join(localRoot, id), bytes, { flag: 'wx', mode: 0o600 })
  return key
}

export async function readProof(key: string) {
  const id = validateKey(key)
  try {
    if (key.startsWith('r2/')) {
      if (!r2Client)
        throw new AppError(503, 'PRIVATE_STORAGE_REQUIRED', 'Private proof storage is unavailable.')
      const response = await r2Client.send(
        new GetObjectCommand({ Bucket: env.r2.bucketName, Key: key }),
      )
      if (!response.Body) throw new AppError(404, 'PROOF_NOT_FOUND', 'Proof not found.')
      if ((response.ContentLength ?? 0) > maxProofBytes) {
        // Release the Node HTTP response immediately when rejecting its size.
        const body = response.Body as typeof response.Body & { destroy?: () => void }
        body.destroy?.()
        throw new AppError(
          503,
          'PROOF_STORAGE_INVALID',
          'The stored proof needs administrator review.',
        )
      }
      // Bound reads even if an object is changed outside the application or its
      // content-length is missing. Never buffer an arbitrary storage object.
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        const bytes = Buffer.from(chunk)
        total += bytes.length
        if (total > maxProofBytes)
          throw new AppError(
            503,
            'PROOF_STORAGE_INVALID',
            'The stored proof needs administrator review.',
          )
        chunks.push(bytes)
      }
      return Buffer.concat(chunks, total)
    }
    const filePath = path.join(localRoot, id)
    const metadata = await stat(filePath)
    if (!metadata.isFile() || metadata.size > maxProofBytes)
      throw new AppError(
        503,
        'PROOF_STORAGE_INVALID',
        'The stored proof needs administrator review.',
      )
    return await readFile(filePath)
  } catch (error) {
    if (error instanceof AppError) throw error
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT')
      throw new AppError(404, 'PROOF_NOT_FOUND', 'The proof file is unavailable.')
    throw new AppError(
      503,
      'PROOF_STORAGE_UNAVAILABLE',
      'The proof could not be retrieved. Try again.',
    )
  }
}

export async function removeStoredProof(key: string) {
  const id = validateKey(key)
  if (key.startsWith('r2/')) {
    if (r2Client)
      await r2Client.send(new DeleteObjectCommand({ Bucket: env.r2.bucketName, Key: key }))
  } else
    await unlink(path.join(localRoot, id)).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return
      throw error
    })
}
