import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { classifyPgClientFailure, createPgClientEnvironment } from './recovery-diagnostics.mjs'
import pg from 'pg'

const { Client } = pg
const magic = Buffer.from('CBMSR1')
const headerSize = magic.length + 12
const tagSize = 16
const runId = process.env.GITHUB_RUN_ID
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS)
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cbms-staging-recovery-'))
const dumpPath = path.join(tempDir, 'staging.dump')
const encryptedPath = path.join(tempDir, 'staging.dump.enc')

let stagingClient
let recoveryClient
let stagingS3
let recoveryS3
let currentPhase = 'initialization'

try {
  currentPhase = 'configuration validation'
  const stagingUrl = databaseUrl('STAGING_DATABASE_URL')
  const recoveryUrl = databaseUrl('RECOVERY_DATABASE_URL')
  if (stagingUrl.hostname === recoveryUrl.hostname)
    stop('Staging and recovery must use different Neon endpoints.')
  if (!runId || !/^\d+$/.test(runId)) stop('A valid GitHub Actions run ID is required.')
  if (retentionDays !== 30)
    stop('BACKUP_RETENTION_DAYS must match the approved 30-day recovery retention.')

  const encryptionKey = parseEncryptionKey(required('BACKUP_ENCRYPTION_KEY'))
  currentPhase = 'database connection'
  stagingClient = new Client({ connectionString: stagingUrl.href, connectionTimeoutMillis: 15000 })
  recoveryClient = new Client({
    connectionString: recoveryUrl.href,
    connectionTimeoutMillis: 15000,
  })
  await Promise.all([stagingClient.connect(), recoveryClient.connect()])

  currentPhase = 'recovery database emptiness check'
  const target = await recoveryClient.query('select current_database() as name')
  const expectedRecoveryDatabase = decodeURIComponent(recoveryUrl.pathname.slice(1))
  if (target.rows[0]?.name !== expectedRecoveryDatabase)
    stop('Recovery database identity could not be verified.')
  await requireEmptyRecoveryDatabase(recoveryClient)

  currentPhase = 'staging snapshot and database dump'
  const stagingSnapshot = await readStagingSnapshot(stagingClient, stagingUrl, dumpPath)
  const recoveryBucket = required('RECOVERY_R2_BUCKET_NAME')
  const stagingBucket = required('STAGING_R2_BUCKET_NAME')
  if (recoveryBucket === stagingBucket) stop('Staging and recovery R2 buckets must be different.')

  stagingS3 = makeS3('STAGING')
  recoveryS3 = makeS3('RECOVERY')
  currentPhase = 'private proof-object preflight'
  await preflightProofObjects(
    stagingS3,
    recoveryS3,
    stagingBucket,
    recoveryBucket,
    stagingSnapshot.attachments,
  )
  currentPhase = 'private proof-object copy and verification'
  const proofResults = await copyAndVerifyProofObjects(
    stagingS3,
    recoveryS3,
    stagingBucket,
    recoveryBucket,
    stagingSnapshot.attachments,
  )

  currentPhase = 'encrypted database backup upload and verification'
  await encryptDump(dumpPath, encryptedPath, encryptionKey)
  const encryptedStat = await stat(encryptedPath)
  const backupKey = `cbms-recovery/backups/staging-${runId}.dump.enc`
  await recoveryS3.send(
    new PutObjectCommand({
      Bucket: recoveryBucket,
      Key: backupKey,
      Body: createReadStream(encryptedPath),
      ContentLength: encryptedStat.size,
      ContentType: 'application/octet-stream',
      Metadata: {
        format: 'cbms-aes-256-gcm-v1',
        'retention-days': String(retentionDays),
        sha256: await hashFile(encryptedPath),
      },
    }),
  )
  const storedBackup = await recoveryS3.send(
    new HeadObjectCommand({ Bucket: recoveryBucket, Key: backupKey }),
  )
  if (
    storedBackup.ContentLength !== encryptedStat.size ||
    storedBackup.Metadata?.sha256 !== (await hashFile(encryptedPath))
  )
    stop('Encrypted database backup failed remote storage verification.')

  currentPhase = 'database restore into isolated recovery target'
  await restoreDatabase(recoveryUrl, encryptedPath, encryptionKey)
  currentPhase = 'restored database and proof verification'
  const verified = await verifyDatabaseAndProofs(
    recoveryClient,
    recoveryS3,
    recoveryBucket,
    stagingSnapshot.attachments,
    proofResults.hashes,
  )
  console.info(
    `Staging recovery rehearsal passed: restored database verified; ${verified.attachments} attachment records and matching private proof objects verified; encrypted backup stored under the recovery backup prefix.`,
  )
  console.info('Proof object count copied or already identical:', proofResults.verified)
} catch (error) {
  if (error?.name === 'RecoveryError') console.error(error.message)
  else {
    const command = ['pg_dump', 'pg_restore'].includes(error?.commandName)
      ? `${error.commandName}${Number.isInteger(error.exitCode) ? ` exited with code ${error.exitCode}` : ' could not start'}`
      : null
    const errorCode =
      typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code)
        ? ` (error code ${error.code})`
        : ''
    const safeHint = typeof error?.safeHint === 'string' ? ` (${error.safeHint})` : ''
    console.error(
      `Staging recovery rehearsal failed during ${currentPhase}${command ? `: ${command}${safeHint}` : `${errorCode}${safeHint}`}. No credentials, record contents, or raw provider error messages were logged. Inspect the failed phase and recovery target state before retrying.`,
    )
  }
  process.exitCode = 1
} finally {
  await Promise.allSettled([stagingClient?.end(), recoveryClient?.end()])
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
  if (!url.hostname.endsWith('.neon.tech'))
    stop(`${name} must point to the approved Neon resource.`)
  if (url.hostname.includes('.pooler.') || url.hostname.includes('-pooler.'))
    stop(`${name} must use a direct, unpooled Neon endpoint.`)
  return url
}

function parseEncryptionKey(value) {
  let key
  if (/^[a-f0-9]{64}$/i.test(value)) key = Buffer.from(value, 'hex')
  else key = Buffer.from(value, 'base64url')
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

async function requireEmptyRecoveryDatabase(client) {
  const [relations, schemas] = await Promise.all([
    client.query(`
    select count(*)::int as objects
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname not in ('pg_catalog','information_schema')
      and n.nspname !~ '^pg_toast'
      and c.relkind in ('r','p','v','m','S','f')
  `),
    client.query(`
    select count(*)::int as objects from pg_catalog.pg_namespace
    where nspname not in ('pg_catalog','information_schema','public')
      and nspname !~ '^pg_toast'
  `),
  ])
  if (relations.rows[0]?.objects !== 0 || schemas.rows[0]?.objects !== 0)
    stop('Recovery database is not empty. Refusing to overwrite or merge data.')
}

async function readStagingSnapshot(client, url, destination) {
  await client.query('begin transaction isolation level repeatable read read only')
  try {
    const snapshot = await client.query('select pg_export_snapshot() as id')
    const attachments = await client.query(
      'select object_key as "objectKey", file_size as "fileSize", mime_type as "mimeType" from attachments order by id',
    )
    const env = createPgClientEnvironment(url)
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
      { env },
    )
    return { attachments: attachments.rows }
  } finally {
    await client.query('rollback').catch(() => undefined)
  }
}

async function preflightProofObjects(source, target, sourceBucket, targetBucket, attachments) {
  for (const item of attachments) {
    if (!/^r2\/[a-f0-9-]{36}$/.test(item.objectKey) || item.fileSize > 10 * 1024 * 1024)
      stop(
        'A staging attachment is outside the supported private proof-object format or size limit.',
      )
    const original = await readObject(source, sourceBucket, item.objectKey)
    if (original.length !== item.fileSize)
      stop('A staging proof object does not match its database file size.')
    try {
      const existing = await readObject(target, targetBucket, item.objectKey)
      if (!existing.equals(original))
        stop('A recovery proof key already exists with different content.')
    } catch (error) {
      if (error?.name !== 'NoSuchKey' && error?.$metadata?.httpStatusCode !== 404) throw error
    }
  }
}

async function copyAndVerifyProofObjects(source, target, sourceBucket, targetBucket, attachments) {
  let verified = 0
  const hashes = new Map()
  for (const item of attachments) {
    const original = await readObject(source, sourceBucket, item.objectKey)
    if (original.length !== item.fileSize)
      stop('A staging proof object does not match its database file size.')
    let alreadyPresent = false
    try {
      const existing = await readObject(target, targetBucket, item.objectKey)
      if (!existing.equals(original)) stop('A recovery proof key changed after preflight.')
      alreadyPresent = true
    } catch (error) {
      if (error?.name !== 'NoSuchKey' && error?.$metadata?.httpStatusCode !== 404) throw error
    }
    if (!alreadyPresent) {
      await target.send(
        new PutObjectCommand({
          Bucket: targetBucket,
          Key: item.objectKey,
          Body: original,
          ContentLength: original.length,
          ContentType: item.mimeType,
        }),
      )
    }
    const recovered = await readObject(target, targetBucket, item.objectKey)
    const expectedHash = sha256(original)
    if (recovered.length !== item.fileSize || sha256(recovered) !== expectedHash)
      stop('A recovered proof object failed content verification.')
    hashes.set(item.objectKey, expectedHash)
    verified += 1
  }
  return { verified, hashes }
}

async function readObject(client, bucket, key) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  return Buffer.from(await response.Body.transformToByteArray())
}

async function encryptDump(source, destination, key) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  await writeFile(destination, Buffer.concat([magic, nonce]), { flag: 'wx', mode: 0o600 })
  await pipeline(
    createReadStream(source),
    cipher,
    createWriteStream(destination, { flags: 'a', mode: 0o600 }),
  )
  await appendFile(destination, cipher.getAuthTag(), { mode: 0o600 })
}

async function restoreDatabase(url, encrypted, key) {
  const fileInfo = await stat(encrypted)
  if (fileInfo.size < headerSize + tagSize) stop('Encrypted database backup format is invalid.')
  const file = await open(encrypted, 'r')
  const header = Buffer.alloc(headerSize)
  const tag = Buffer.alloc(tagSize)
  try {
    await file.read(header, 0, headerSize, 0)
    await file.read(tag, 0, tagSize, fileInfo.size - tagSize)
  } finally {
    await file.close()
  }
  if (!header.subarray(0, magic.length).equals(magic))
    stop('Encrypted database backup format is invalid.')
  const nonce = header.subarray(magic.length, headerSize)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  const env = createPgClientEnvironment(url)
  await runWithInput(
    'pg_restore',
    [
      '--exit-on-error',
      '--no-owner',
      '--no-acl',
      '--dbname',
      decodeURIComponent(url.pathname.slice(1)),
    ],
    createReadStream(encrypted, { start: headerSize, end: fileInfo.size - tagSize - 1 }).pipe(
      decipher,
    ),
    { env },
  )
}

async function verifyDatabaseAndProofs(client, storage, bucket, attachments, expectedHashes) {
  const restored = await client.query(
    'select object_key as "objectKey", file_size as "fileSize" from attachments order by id',
  )
  if (restored.rowCount !== attachments.length)
    stop('Restored attachment record count does not match the staging snapshot.')
  for (let index = 0; index < attachments.length; index += 1) {
    const expected = attachments[index]
    const actual = restored.rows[index]
    if (actual.objectKey !== expected.objectKey || actual.fileSize !== expected.fileSize)
      stop('A restored attachment record differs from the staging snapshot.')
    const proof = await readObject(storage, bucket, actual.objectKey)
    if (proof.length !== actual.fileSize || sha256(proof) !== expectedHashes.get(actual.objectKey))
      stop('A restored database record does not match its recovery proof object.')
  }
  const migrations = await client.query(
    'select count(*)::int as count from drizzle.__drizzle_migrations',
  )
  const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
  if (migrations.rows[0]?.count !== journal.entries.length)
    stop('Restored migration journal does not match the migrations in this release.')
  return { attachments: restored.rowCount }
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

function runWithInput(command, args, input, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['pipe', 'ignore', 'pipe'] })
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
    input.once('error', () => child.kill())
    input.pipe(child.stdin)
  })
}

function stop(message) {
  const error = new Error(message)
  error.name = 'RecoveryError'
  throw error
}
