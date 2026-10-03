import { createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import pg from 'pg'
import { classifyPgClientFailure, createPgClientEnvironment } from './recovery-diagnostics.mjs'
import {
  approvedRecoveryBucket,
  getArchivedProofKey,
  getDailyBackupPaths,
  getRestoreConfirmation,
  validateDailyBackupManifest,
} from './daily-backup-paths.mjs'

const { Client } = pg
const magic = Buffer.from('CBMSR1')
const headerSize = magic.length + 12
const tagSize = 16
const startedAt = new Date()
const runId = process.env.RECOVERY_BACKUP_RUN_ID
const runAttempt = process.env.RECOVERY_BACKUP_RUN_ATTEMPT
const targetName = process.env.RECOVERY_DATABASE_NAME
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cbms-scheduled-restore-'))
const encryptedPath = path.join(tempDir, 'staging.dump.enc')
const dumpPath = path.join(tempDir, 'staging.dump')

let database
let storage
let currentPhase = 'initialization'

try {
  currentPhase = 'configuration validation'
  if (process.env.GITHUB_REF !== 'refs/heads/main')
    stop('Scheduled backup restores may only run from the main branch.')
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch')
    stop('Scheduled backup restores require a manual workflow dispatch.')
  if (!runId || !/^\d+$/.test(runId) || !runAttempt || !/^\d+$/.test(runAttempt))
    stop('Numeric backup run and attempt IDs are required.')
  const paths = getDailyBackupPaths(runId, runAttempt)
  const confirmation = getRestoreConfirmation(runId, runAttempt, targetName ?? '')
  if (process.env.RECOVERY_RESTORE_CONFIRMATION !== confirmation)
    stop('The run, attempt, target database, and exact restore confirmation must match.')

  const recoveryUrl = databaseUrl('RECOVERY_DATABASE_URL')
  if (decodeURIComponent(recoveryUrl.pathname.slice(1)) !== targetName)
    stop('The recovery URL database name does not match the confirmed target name.')
  const expectedRecoveryHost = required('RECOVERY_DATABASE_HOST').toLowerCase()
  if (recoveryUrl.hostname.toLowerCase() !== expectedRecoveryHost)
    stop('The recovery URL host does not match the explicitly configured recovery Neon host.')
  const retentionDays = Number(required('BACKUP_RETENTION_DAYS'))
  if (retentionDays !== 30)
    stop('BACKUP_RETENTION_DAYS must match the approved 30-day recovery retention.')
  const bucket = required('RECOVERY_R2_BUCKET_NAME')
  if (bucket !== approvedRecoveryBucket)
    stop('RECOVERY_R2_BUCKET_NAME must identify the approved private recovery bucket.')
  const encryptionKey = parseEncryptionKey(required('BACKUP_ENCRYPTION_KEY'))

  currentPhase = 'recovery database connection and empty-target check'
  database = new Client({ connectionString: recoveryUrl.href, connectionTimeoutMillis: 15000 })
  await database.connect()
  const identity = await database.query('select current_database() as name')
  if (identity.rows[0]?.name !== targetName)
    stop('Recovery database identity could not be verified.')
  await requireEmptyRecoveryDatabase(database)

  currentPhase = 'selected run manifest verification'
  storage = makeRecoveryS3()
  const manifestBytes = await readObject(storage, bucket, paths.manifestKey)
  const manifestHead = await storage.send(
    new HeadObjectCommand({ Bucket: bucket, Key: paths.manifestKey }),
  )
  if (
    manifestHead.ContentLength !== manifestBytes.length ||
    manifestHead.Metadata?.sha256 !== sha256(manifestBytes)
  )
    stop('The selected backup manifest failed size verification.')
  const manifest = parseManifest(manifestBytes)
  validateDailyBackupManifest(manifest, runId, runAttempt, retentionDays)
  const storedArchive = await storage.send(
    new HeadObjectCommand({ Bucket: bucket, Key: manifest.databaseBackup.key }),
  )
  if (
    storedArchive.ContentLength !== manifest.databaseBackup.size ||
    storedArchive.Metadata?.sha256 !== manifest.databaseBackup.sha256
  )
    stop('The selected database archive does not match its manifest.')

  currentPhase = 'selected encrypted archive download and integrity verification'
  const encrypted = await storage.send(
    new GetObjectCommand({ Bucket: bucket, Key: manifest.databaseBackup.key }),
  )
  await pipeline(encrypted.Body, createWriteStream(encryptedPath, { flags: 'wx', mode: 0o600 }))
  if (
    (await stat(encryptedPath)).size !== manifest.databaseBackup.size ||
    (await hashFile(encryptedPath)) !== manifest.databaseBackup.sha256
  )
    stop('The selected encrypted archive failed manifest hash verification.')

  currentPhase = 'selected proof archive preflight'
  const proofBytes = new Map()
  for (const proof of manifest.proofs) {
    const archivedProof = await readObject(storage, bucket, proof.archivedKey)
    if (archivedProof.length !== proof.fileSize || sha256(archivedProof) !== proof.sha256)
      stop('A selected archived proof failed manifest verification.')
    const existing = await readObjectIfPresent(storage, bucket, proof.sourceKey)
    if (existing && (existing.length !== proof.fileSize || sha256(existing) !== proof.sha256))
      stop(
        'A recovery proof key already exists with different content; no database restore was started.',
      )
    proofBytes.set(proof.sourceKey, archivedProof)
  }

  currentPhase = 'archive decryption and database restore'
  await decryptArchive(encryptedPath, dumpPath, encryptionKey)
  await restoreDatabase(recoveryUrl, dumpPath)

  currentPhase = 'applying current repository migrations to the isolated recovery database'
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'db:migrate'], {
    env: { ...process.env, DATABASE_URL: recoveryUrl.href },
  })

  currentPhase = 'isolated recovered API health and readiness check'
  await verifyRecoveredApi(recoveryUrl, bucket, tempDir)

  currentPhase = 'matching proof restoration and verification'
  for (const [key, bytes] of proofBytes) {
    const existing = await readObjectIfPresent(storage, bucket, key)
    if (!existing) {
      await storage.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: manifest.proofs.find((proof) => proof.sourceKey === key).mimeType,
        }),
      )
    }
    const stored = await readObject(storage, bucket, key)
    if (stored.length !== bytes.length || sha256(stored) !== sha256(bytes))
      stop('A restored proof object failed content verification.')
  }

  currentPhase = 'restored database, representative records, relationships, and proof verification'
  const verified = await verifyRestoredDatabase(database, storage, bucket, manifest)
  const elapsedMs = Date.now() - startedAt.getTime()
  const snapshotAgeMs = manifest.snapshotAt
    ? startedAt.getTime() - Date.parse(manifest.snapshotAt)
    : null
  if (snapshotAgeMs !== null && snapshotAgeMs < 0)
    stop('The selected backup snapshot timestamp is in the future.')
  console.info(
    JSON.stringify({
      status: 'passed',
      backupRunId: runId,
      backupRunAttempt: runAttempt,
      recoveryDatabase: targetName,
      backupCreatedAt: manifest.createdAt,
      snapshotAt: manifest.snapshotAt ?? null,
      recoveryStartedAt: startedAt.toISOString(),
      recoveryCompletedAt: new Date().toISOString(),
      recoveryElapsedMs: elapsedMs,
      snapshotAgeMs,
      snapshotAgeWithin24HourTarget:
        snapshotAgeMs === null ? null : snapshotAgeMs <= 24 * 60 * 60 * 1000,
      verified,
      apiHealthAndReadiness: 'passed',
      rpoMeasurement: manifest.snapshotAt ? 'available' : 'unavailable: archive has no snapshotAt',
      rtoMeasurement: 'database, proof, and isolated API health/readiness recovery only',
    }),
  )
} catch (error) {
  if (error?.name === 'RecoveryError') console.error(error.message)
  else {
    const command =
      error?.commandName === 'pg_restore'
        ? 'pg_restore failed'
        : ['npm', 'npm.cmd'].includes(error?.commandName)
          ? 'current repository migrations failed'
          : null
    const errorCode =
      typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code)
        ? ` (${error.code})`
        : ''
    const safeHint = typeof error?.safeHint === 'string' ? ` (${error.safeHint})` : ''
    console.error(
      `Scheduled backup restore failed during ${currentPhase}${command ? `: ${command}${safeHint}` : errorCode}. No credentials, record contents, proof contents, or raw provider errors were logged. Inspect the recovery target before retrying; never clear it automatically.`,
    )
  }
  process.exitCode = 1
} finally {
  await database?.end().catch(() => undefined)
  storage?.destroy()
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
  if (key.length !== 32) stop('BACKUP_ENCRYPTION_KEY must encode exactly 32 random bytes.')
  return key
}

function makeRecoveryS3() {
  const accountId = required('RECOVERY_R2_ACCOUNT_ID')
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: required('RECOVERY_R2_ACCESS_KEY_ID'),
      secretAccessKey: required('RECOVERY_R2_SECRET_ACCESS_KEY'),
    },
  })
}

async function requireEmptyRecoveryDatabase(client) {
  const [relations, schemas] = await Promise.all([
    client.query(`
      select count(*)::int as objects from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname not in ('pg_catalog','information_schema')
        and n.nspname !~ '^pg_toast' and c.relkind in ('r','p','v','m','S','f')
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

function parseManifest(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    stop('The selected backup manifest is not valid JSON.')
  }
}

async function readObject(client, bucket, key) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  return Buffer.from(await response.Body.transformToByteArray())
}

async function readObjectIfPresent(client, bucket, key) {
  try {
    return await readObject(client, bucket, key)
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null
    throw error
  }
}

async function decryptArchive(source, destination, key) {
  const fileInfo = await stat(source)
  if (fileInfo.size < headerSize + tagSize + 1) stop('Encrypted database archive is too small.')
  const file = await open(source, 'r')
  const header = Buffer.alloc(headerSize)
  const tag = Buffer.alloc(tagSize)
  try {
    await file.read(header, 0, headerSize, 0)
    await file.read(tag, 0, tagSize, fileInfo.size - tagSize)
  } finally {
    await file.close()
  }
  if (!header.subarray(0, magic.length).equals(magic))
    stop('Encrypted database archive format is not supported.')
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(magic.length))
  decipher.setAuthTag(tag)
  await pipeline(
    createReadStream(source, { start: headerSize, end: fileInfo.size - tagSize - 1 }),
    decipher,
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
  )
}

async function restoreDatabase(url, dump) {
  await run(
    'pg_restore',
    [
      '--exit-on-error',
      '--no-owner',
      '--no-acl',
      '--dbname',
      decodeURIComponent(url.pathname.slice(1)),
      dump,
    ],
    { env: createPgClientEnvironment(url) },
  )
}

async function verifyRestoredDatabase(client, storageClient, bucket, manifest) {
  const actual = await client.query(
    'select object_key as "objectKey", file_size as "fileSize", mime_type as "mimeType" from attachments order by object_key',
  )
  const expected = [...manifest.proofs]
    .map((proof) => ({
      objectKey: proof.sourceKey,
      fileSize: proof.fileSize,
      mimeType: proof.mimeType,
    }))
    .sort((left, right) => left.objectKey.localeCompare(right.objectKey))
  if (actual.rowCount !== expected.length)
    stop('Restored attachment count differs from its manifest.')
  for (let index = 0; index < expected.length; index += 1) {
    const found = actual.rows[index]
    const proof = expected[index]
    if (
      found.objectKey !== proof.objectKey ||
      Number(found.fileSize) !== proof.fileSize ||
      found.mimeType !== proof.mimeType
    )
      stop('A restored attachment does not match its manifest entry.')
  }

  const unvalidatedConstraints = await client.query(`
    select count(*)::int as count from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid=c.conrelid
    join pg_catalog.pg_namespace n on n.oid=t.relnamespace
    where n.nspname='public' and c.contype='f' and not c.convalidated
  `)
  if (unvalidatedConstraints.rows[0]?.count !== 0)
    stop('The restored database contains unvalidated foreign-key constraints.')

  const mismatches = await client.query(`
    select
      (select count(*)::int from orders o left join customers c on c.id=o.customer_id where c.id is null) as orders_without_customer,
      (select count(*)::int from orders o left join branches b on b.id=o.branch_id where b.id is null) as orders_without_branch,
      (select count(*)::int from payments p left join orders o on o.id=p.order_id where o.id is null) as payments_without_order,
      (select count(*)::int from deliveries d left join orders o on o.id=d.order_id where o.id is null) as deliveries_without_order,
      (select count(*)::int from payroll_entries e left join payroll_runs r on r.id=e.payroll_run_id where r.id is null) as payroll_without_run,
      (select count(*)::int from payroll_entries e left join employees p on p.id=e.employee_id where p.id is null) as payroll_without_employee,
      (select count(*)::int from payroll_entries e left join branches b on b.id=e.branch_id where b.id is null) as payroll_without_branch
  `)
  if (Object.values(mismatches.rows[0] ?? {}).some((count) => count !== 0))
    stop('Restored business relationships failed verification.')

  const counts = await client.query(`
    select
      (select count(*)::int from branches) as branches,
      (select count(*)::int from customers) as customers,
      (select count(*)::int from employees) as employees,
      (select count(*)::int from orders) as orders,
      (select count(*)::int from payments) as payments,
      (select count(*)::int from deliveries) as deliveries,
      (select count(*)::int from payroll_runs) as payroll_runs,
      (select count(*)::int from payroll_entries) as payroll_entries
  `)
  if (counts.rows[0].branches < 1) stop('Restored database has no branch records.')

  const migrations = await client.query(
    'select count(*)::int as count from drizzle.__drizzle_migrations',
  )
  const journal = JSON.parse(
    await (await import('node:fs/promises')).readFile('drizzle/meta/_journal.json', 'utf8'),
  )
  if (migrations.rows[0]?.count !== journal.entries.length)
    stop('Restored migration journal differs from this release.')

  for (const proof of manifest.proofs) {
    const bytes = await readObject(storageClient, bucket, proof.sourceKey)
    if (bytes.length !== proof.fileSize || sha256(bytes) !== proof.sha256)
      stop('A restored database proof mapping does not match its private R2 object.')
  }

  return {
    migrations: migrations.rows[0].count,
    branches: counts.rows[0].branches,
    customers: counts.rows[0].customers,
    employees: counts.rows[0].employees,
    orders: counts.rows[0].orders,
    payments: counts.rows[0].payments,
    deliveries: counts.rows[0].deliveries,
    payrollRuns: counts.rows[0].payroll_runs,
    payrollEntries: counts.rows[0].payroll_entries,
    proofObjects: manifest.proofs.length,
    foreignKeyRelationships: 'validated',
  }
}

async function verifyRecoveredApi(url, bucket, directory) {
  const serverPath = path.resolve('dist/src/server.js')
  await stat(serverPath).catch(() => stop('The compiled recovery API server is unavailable.'))
  const port = await getAvailablePort()
  const apiEnvironment = {
    PATH: process.env.PATH ?? '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    NODE_ENV: 'production',
    DATABASE_URL: url.href,
    SESSION_SECRET: createHash('sha256').update(randomBytes(48)).digest('hex'),
    PORT: String(port),
    FRONTEND_URL: 'http://127.0.0.1',
    CORS_ORIGINS: 'http://127.0.0.1',
    LOCAL_UPLOAD_DIR: path.join(directory, 'api-private-uploads'),
    R2_ACCOUNT_ID: required('RECOVERY_R2_ACCOUNT_ID'),
    R2_ACCESS_KEY_ID: required('RECOVERY_R2_ACCESS_KEY_ID'),
    R2_SECRET_ACCESS_KEY: required('RECOVERY_R2_SECRET_ACCESS_KEY'),
    R2_BUCKET_NAME: bucket,
  }
  const child = spawn(process.execPath, [serverPath], {
    cwd: process.cwd(),
    env: apiEnvironment,
    stdio: 'ignore',
  })
  let spawnFailed = false
  child.once('error', () => {
    spawnFailed = true
  })
  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30000
  try {
    while (Date.now() < deadline) {
      if (spawnFailed || child.exitCode !== null || child.signalCode !== null)
        stop('The restored API exited before health and readiness checks passed.')
      try {
        const health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) })
        const healthBody = await health.json()
        const readiness = await fetch(`${baseUrl}/api/ready`, {
          signal: AbortSignal.timeout(1500),
        })
        const readinessBody = await readiness.json()
        if (
          health.ok &&
          healthBody?.status === 'ok' &&
          healthBody?.service === 'cbms-api' &&
          readiness.ok &&
          readinessBody?.status === 'ready' &&
          readinessBody?.service === 'cbms-api'
        )
          return
      } catch {
        // Startup can take a few seconds; retry until the bounded deadline.
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    stop('The restored API did not pass health and readiness checks within 30 seconds.')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise((resolve) => child.once('close', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }
}

async function getAvailablePort() {
  const server = createNetServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    stop('A local port for the recovery API is unavailable.')
  const { port } = address
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
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
    child.stderr.on('data', (chunk) => {
      if (errorOutputSize >= 8192) return
      const safeChunk = Buffer.from(chunk).subarray(0, 8192 - errorOutputSize)
      errorOutput.push(safeChunk)
      errorOutputSize += safeChunk.length
    })
    child.once('error', () => reject(new Error(`${command} could not be started.`)))
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
