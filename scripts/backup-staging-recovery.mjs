import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { classifyPgClientFailure, createPgClientEnvironment } from './recovery-diagnostics.mjs'
import {
  approvedRecoveryBucket,
  getDailyBackupPaths,
  getArchivedProofKey,
} from './daily-backup-paths.mjs'
import pg from 'pg'

const { Client } = pg
const runId = process.env.GITHUB_RUN_ID
const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1'
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS)
const recoveryBucketName = process.env.RECOVERY_R2_BUCKET_NAME
const stagingBucketName = process.env.STAGING_R2_BUCKET_NAME
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cbms-daily-backup-'))
const dumpPath = path.join(tempDir, 'staging.dump')
const encryptedPath = path.join(tempDir, 'staging.dump.enc')

let stagingClient
let stagingS3
let recoveryS3
let currentPhase = 'initialization'

try {
  currentPhase = 'configuration validation'
  const stagingUrl = databaseUrl('STAGING_DATABASE_URL')
  if (process.env.GITHUB_REF !== 'refs/heads/main')
    stop('Staging backups may only run from the main branch.')
  if (!['schedule', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME))
    stop('Staging backups may only run on schedule or manual dispatch.')
  if (!runId || !/^\d+$/.test(runId) || !/^\d+$/.test(runAttempt))
    stop('Valid GitHub Actions run and attempt IDs are required.')
  if (retentionDays !== 30)
    stop('BACKUP_RETENTION_DAYS must match the approved 30-day recovery retention.')
  if (recoveryBucketName !== approvedRecoveryBucket)
    stop('RECOVERY_R2_BUCKET_NAME must identify the approved private recovery bucket.')
  if (!stagingBucketName || stagingBucketName === recoveryBucketName)
    stop('Staging and recovery R2 buckets must be different.')

  const encryptionKey = parseEncryptionKey(required('BACKUP_ENCRYPTION_KEY'))
  stagingClient = new Client({ connectionString: stagingUrl.href, connectionTimeoutMillis: 15000 })
  await stagingClient.connect()
  stagingS3 = makeS3('STAGING')
  recoveryS3 = makeS3('RECOVERY')

  currentPhase = 'staging snapshot and database dump'
  const snapshot = await readStagingSnapshot(stagingClient, stagingUrl, dumpPath)
  const backupPaths = getDailyBackupPaths(runId, runAttempt)
  const proofManifest = await archiveProofObjects(
    stagingS3,
    recoveryS3,
    stagingBucketName,
    recoveryBucketName,
    runId,
    runAttempt,
    snapshot.attachments,
  )

  currentPhase = 'encrypted database backup upload and verification'
  await encryptDump(dumpPath, encryptedPath, encryptionKey)
  const encryptedStat = await stat(encryptedPath)
  const backupKey = backupPaths.databaseBackupKey
  const encryptedHash = await hashFile(encryptedPath)
  await recoveryS3.send(
    new PutObjectCommand({
      Bucket: recoveryBucketName,
      Key: backupKey,
      Body: createReadStream(encryptedPath),
      ContentLength: encryptedStat.size,
      ContentType: 'application/octet-stream',
      Metadata: {
        format: 'cbms-aes-256-gcm-v1',
        'retention-days': String(retentionDays),
        sha256: encryptedHash,
      },
    }),
  )
  const storedBackup = await recoveryS3.send(
    new HeadObjectCommand({ Bucket: recoveryBucketName, Key: backupKey }),
  )
  if (
    storedBackup.ContentLength !== encryptedStat.size ||
    storedBackup.Metadata?.sha256 !== encryptedHash
  )
    stop('Encrypted database backup failed remote storage verification.')

  currentPhase = 'recovery manifest upload and verification'
  const manifestKey = backupPaths.manifestKey
  const manifest = Buffer.from(
    JSON.stringify({
      format: 'cbms-staging-backup-manifest-v1',
      runId,
      runAttempt,
      createdAt: new Date().toISOString(),
      retentionDays,
      databaseBackup: { key: backupKey, size: encryptedStat.size, sha256: encryptedHash },
      proofs: proofManifest,
    }),
  )
  const manifestHash = sha256(manifest)
  await recoveryS3.send(
    new PutObjectCommand({
      Bucket: recoveryBucketName,
      Key: manifestKey,
      Body: manifest,
      ContentLength: manifest.length,
      ContentType: 'application/json',
      Metadata: { sha256: manifestHash, 'retention-days': String(retentionDays) },
    }),
  )
  const storedManifest = await recoveryS3.send(
    new HeadObjectCommand({ Bucket: recoveryBucketName, Key: manifestKey }),
  )
  if (
    storedManifest.ContentLength !== manifest.length ||
    storedManifest.Metadata?.sha256 !== manifestHash
  )
    stop('Recovery manifest failed remote storage verification.')

  console.info(
    `Staging daily backup passed: encrypted database snapshot and manifest verified; ${proofManifest.length} private proof objects verified; 30-day retention metadata recorded.`,
  )
} catch (error) {
  if (error?.name === 'RecoveryError') console.error(error.message)
  else {
    const command =
      error?.commandName === 'pg_dump'
        ? `${error.commandName}${Number.isInteger(error.exitCode) ? ` exited with code ${error.exitCode}` : ' could not start'}`
        : null
    const errorCode =
      typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code)
        ? ` (error code ${error.code})`
        : ''
    const safeHint = typeof error?.safeHint === 'string' ? ` (${error.safeHint})` : ''
    console.error(
      `Staging daily backup failed during ${currentPhase}${command ? `: ${command}${safeHint}` : `${errorCode}${safeHint}`}. No credentials, record contents, or raw provider error messages were logged.`,
    )
  }
  process.exitCode = 1
} finally {
  await stagingClient?.end().catch(() => undefined)
  stagingS3?.destroy()
  recoveryS3?.destroy()
  await rm(tempDir, { recursive: true, force: true })
}

function required(name) {
  const value = process.env[name]
  if (!value) stop(`${name} is required.`)
  return value
}

function databaseUrl(name) {
  const value = required(name)
  let url
  try {
    url = new URL(value)
  } catch {
    stop(`${name} must be a valid PostgreSQL URL.`)
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.password)
    stop(`${name} must include a PostgreSQL endpoint and credentials.`)
  if (!url.hostname.endsWith('.neon.tech')) stop(`${name} must point to an approved Neon resource.`)
  if (url.hostname.includes('.pooler.') || url.hostname.includes('-pooler.'))
    stop(`${name} must use a direct, unpooled Neon endpoint.`)
  return url
}

function parseEncryptionKey(value) {
  const key = /^[a-f0-9]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64url')
  if (key.length !== 32)
    stop(
      'BACKUP_ENCRYPTION_KEY must encode exactly 32 random bytes (64 hex characters or base64url).',
    )
  return key
}

function makeS3(prefix) {
  const accountId = required(`${prefix}_R2_ACCOUNT_ID`)
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: required(`${prefix}_R2_ACCESS_KEY_ID`),
      secretAccessKey: required(`${prefix}_R2_SECRET_ACCESS_KEY`),
    },
  })
}

async function readStagingSnapshot(client, url, destination) {
  await client.query('begin transaction isolation level repeatable read read only')
  try {
    const snapshot = await client.query('select pg_export_snapshot() as id')
    const attachments = await client.query(
      'select object_key as "objectKey", file_size as "fileSize", mime_type as "mimeType" from attachments order by id',
    )
    await run(
      'pg_dump',
      [
        '--no-owner',
        '--no-acl',
        '--format=custom',
        `--snapshot=${snapshot.rows[0].id}`,
        `--file=${destination}`,
        '--dbname',
        decodeURIComponent(url.pathname.slice(1)),
      ],
      { env: createPgClientEnvironment(url) },
    )
    return { attachments: attachments.rows }
  } finally {
    await client.query('rollback').catch(() => undefined)
  }
}

async function archiveProofObjects(
  source,
  target,
  sourceBucket,
  targetBucket,
  runId,
  runAttempt,
  attachments,
) {
  const results = []
  for (const item of attachments) {
    if (!/^r2\/[a-f0-9-]{36}$/.test(item.objectKey) || item.fileSize > 10 * 1024 * 1024)
      stop(
        'A staging attachment is outside the supported private proof-object format or size limit.',
      )
    const original = await readObject(source, sourceBucket, item.objectKey)
    if (original.length !== item.fileSize)
      stop('A staging proof object does not match its database file size.')
    const hash = sha256(original)
    const archivedKey = getArchivedProofKey(runId, runAttempt, item.objectKey)
    await target.send(
      new PutObjectCommand({
        Bucket: targetBucket,
        Key: archivedKey,
        Body: original,
        ContentLength: original.length,
        ContentType: item.mimeType,
        Metadata: { sha256: hash, 'source-object-key': item.objectKey },
      }),
    )
    const stored = await readObject(target, targetBucket, archivedKey)
    const head = await target.send(
      new HeadObjectCommand({ Bucket: targetBucket, Key: archivedKey }),
    )
    if (
      stored.length !== item.fileSize ||
      sha256(stored) !== hash ||
      head.ContentLength !== item.fileSize ||
      head.Metadata?.sha256 !== hash
    )
      stop('A daily recovery proof object failed content verification.')
    results.push({
      sourceKey: item.objectKey,
      archivedKey,
      fileSize: item.fileSize,
      mimeType: item.mimeType,
      sha256: hash,
    })
  }
  return results
}

async function readObject(client, bucket, key) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  return Buffer.from(await response.Body.transformToByteArray())
}

async function encryptDump(source, destination, key) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const magic = Buffer.from('CBMSR1')
  await writeFile(destination, Buffer.concat([magic, nonce]), { flag: 'wx', mode: 0o600 })
  await pipeline(
    createReadStream(source),
    cipher,
    createWriteStream(destination, { flags: 'a', mode: 0o600 }),
  )
  await appendFile(destination, cipher.getAuthTag(), { mode: 0o600 })
}

async function hashFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'pipe'] })
    const errorOutput = []
    let errorOutputSize = 0
    child.stderr?.on('data', (chunk) => {
      if (errorOutputSize >= 8192) return
      const captured = Buffer.from(chunk).subarray(0, 8192 - errorOutputSize)
      errorOutput.push(captured)
      errorOutputSize += captured.length
    })
    child.once('error', () => {
      const error = new Error(`${command} could not be started.`)
      error.commandName = command
      reject(error)
    })
    child.once('close', (code) => {
      if (code === 0) return resolve()
      const error = new Error(`${command} failed.`)
      error.commandName = command
      error.exitCode = code
      error.safeHint = classifyPgClientFailure(Buffer.concat(errorOutput).toString('utf8'))
      reject(error)
    })
  })
}

function stop(message) {
  const error = new Error(message)
  error.name = 'RecoveryError'
  throw error
}
