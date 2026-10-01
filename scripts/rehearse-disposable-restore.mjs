import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, Pool } from 'pg'

const backendRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const projectRoot = path.dirname(backendRoot)
const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) fail('DATABASE_URL is required. No database was changed.')

const sourceUrl = new URL(databaseUrl)
const sourceDatabase = decodeURIComponent(sourceUrl.pathname.slice(1))
if (
  !['postgres:', 'postgresql:'].includes(sourceUrl.protocol) ||
  !['localhost', '127.0.0.1', '[::1]'].includes(sourceUrl.hostname) ||
  sourceDatabase !== 'cbms_dev'
) {
  fail('This rehearsal only runs from loopback cbms_dev. No database was changed.')
}

const suffix = randomBytes(8).toString('hex')
const sourceName = `cbms_integration_recovery_source_${suffix}`
const restoredName = `cbms_integration_recovery_restored_${suffix}`
const databaseNamePattern = /^cbms_integration_recovery_(?:source|restored)_[a-f0-9]{16}$/
if (!databaseNamePattern.test(sourceName) || !databaseNamePattern.test(restoredName))
  fail('Disposable database names failed validation.')

const dockerId = await findPostgresContainer()
const databaseUser = decodeURIComponent(sourceUrl.username)
const adminUrl = new URL(databaseUrl)
adminUrl.pathname = '/postgres'
const sourceDatabaseUrl = new URL(databaseUrl)
sourceDatabaseUrl.pathname = `/${sourceName}`
const restoredDatabaseUrl = new URL(databaseUrl)
restoredDatabaseUrl.pathname = `/${restoredName}`
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbms-recovery-rehearsal-'))
const dumpPath = path.join(temporaryRoot, 'synthetic-recovery.dump')
const proofSourceDirectory = path.join(temporaryRoot, 'proof-source')
const proofBackupDirectory = path.join(temporaryRoot, 'proof-backup')
const proofRestoredDirectory = path.join(temporaryRoot, 'proof-restored')
const admin = new Client({ connectionString: adminUrl.href })

let sourceCreated = false
let restoredCreated = false

try {
  await admin.connect()
  await createDatabase(admin, sourceName)
  sourceCreated = true
  await migrateDatabase(sourceDatabaseUrl.href)

  const fixture = await createSyntheticPaymentAndProof(sourceDatabaseUrl.href, proofSourceDirectory)
  await mkdir(proofBackupDirectory, { recursive: true, mode: 0o700 })
  await copyFile(fixture.proofPath, path.join(proofBackupDirectory, fixture.objectId))

  await dumpDatabase(dockerId, databaseUser, sourceName, dumpPath)
  const dumpBytes = await readFile(dumpPath)
  const backupChecksum = createHash('sha256').update(dumpBytes).digest('hex')
  const restoredChecksum = createHash('sha256')
    .update(await readFile(dumpPath))
    .digest('hex')
  if (backupChecksum !== restoredChecksum)
    throw new Error('Disposable database backup checksum mismatch.')

  await createDatabase(admin, restoredName)
  restoredCreated = true
  await restoreDatabase(dockerId, databaseUser, restoredName, dumpPath)
  await migrateDatabase(restoredDatabaseUrl.href)

  await mkdir(proofRestoredDirectory, { recursive: true, mode: 0o700 })
  const backupProofPath = path.join(proofBackupDirectory, fixture.objectId)
  const restoredProofPath = path.join(proofRestoredDirectory, fixture.objectId)
  await copyFile(backupProofPath, restoredProofPath)
  const restoredProof = await readFile(restoredProofPath)
  if (!restoredProof.equals(fixture.proofBytes))
    throw new Error('Restored synthetic proof does not match its backup.')

  const recovered = await verifyRestoredReferences(restoredDatabaseUrl.href, fixture.attachmentId)
  if (recovered.objectKey !== fixture.objectKey || recovered.fileSize !== restoredProof.length)
    throw new Error('Restored payment metadata no longer matches its synthetic proof object.')

  console.info(
    `Disposable restore rehearsal passed: ${recovered.migrationCount} migrations, one synthetic payment, and one linked private proof restored and verified.`,
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Disposable restore rehearsal failed.')
  process.exitCode = 1
} finally {
  if (!admin.ended) await admin.end().catch(() => undefined)
  if (sourceCreated) await dropDatabase(adminUrl.href, sourceName)
  if (restoredCreated) await dropDatabase(adminUrl.href, restoredName)
  await rm(temporaryRoot, { recursive: true, force: true })
}

async function findPostgresContainer() {
  const result = await run('docker', ['compose', 'ps', '-q', 'db'], { cwd: projectRoot })
  const ids = result.stdout.trim().split(/\s+/).filter(Boolean)
  if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/i.test(ids[0] ?? ''))
    fail('Expected one running local Compose PostgreSQL container. No database was changed.')
  return ids[0]
}

async function createDatabase(client, name) {
  if (!databaseNamePattern.test(name))
    throw new Error('Refusing an unrecognized disposable database name.')
  await client.query(`create database "${name}"`)
}

async function dropDatabase(connectionString, name) {
  if (!databaseNamePattern.test(name)) throw new Error('Refusing to drop a non-rehearsal database.')
  const client = new Client({ connectionString })
  try {
    await client.connect()
    await client.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1', [
      name,
    ])
    await client.query(`drop database if exists "${name}"`)
  } finally {
    await client.end().catch(() => undefined)
  }
}

async function migrateDatabase(connectionString) {
  await run(
    process.execPath,
    ['--import=./scripts/node-compat.mjs', '--import=tsx', 'src/database/migrate.ts'],
    {
      cwd: backendRoot,
      env: { ...process.env, DATABASE_URL: connectionString },
    },
  )
}

async function createSyntheticPaymentAndProof(connectionString, proofDirectory) {
  const suffix = randomUUID().slice(0, 8)
  const proofId = randomUUID()
  const objectKey = `local/${proofId}`
  const proofBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=',
    'base64',
  )
  const proofPath = path.join(proofDirectory, proofId)
  await mkdir(proofDirectory, { recursive: true, mode: 0o700 })
  await writeFile(proofPath, proofBytes, { flag: 'wx', mode: 0o600 })

  const pool = new Pool({ connectionString })
  try {
    const branch = await pool.query('insert into branches(name,code) values($1,$2) returning id', [
      `Recovery rehearsal branch ${suffix}`,
      `rr-${suffix}`,
    ])
    const role = await pool.query('insert into roles(name) values($1) returning id', [
      `Recovery rehearsal role ${suffix}`,
    ])
    const user = await pool.query(
      `insert into users(name,email,password_hash,role_id,branch_id)
       values($1,$2,'synthetic-not-a-login-credential',$3,$4) returning id`,
      [
        `Recovery rehearsal user ${suffix}`,
        `recovery-${suffix}@example.invalid`,
        role.rows[0].id,
        branch.rows[0].id,
      ],
    )
    const customer = await pool.query(
      'insert into customers(name,branch_id) values($1,$2) returning id',
      [`Recovery rehearsal customer ${suffix}`, branch.rows[0].id],
    )
    const order = await pool.query(
      `insert into orders(order_number,customer_id,branch_id,total_amount,status,created_by)
       values($1,$2,$3,'5.00','Processing',$4) returning id`,
      [`RR-${suffix}`, customer.rows[0].id, branch.rows[0].id, user.rows[0].id],
    )
    const attachment = await pool.query(
      `insert into attachments(file_name,object_key,mime_type,file_size,uploaded_by,entity_type,entity_id)
       values($1,$2,'image/png',$3,$4,'payment',$5) returning id`,
      [
        `synthetic-receipt-${suffix}.png`,
        objectKey,
        proofBytes.length,
        user.rows[0].id,
        randomUUID(),
      ],
    )
    const payment = await pool.query(
      `insert into payments(reference,order_id,method,amount,recorded_by,payment_proof_attachment_id)
       values($1,$2,'Cash','5.00',$3,$4) returning id`,
      [`RR-PAY-${suffix}`, order.rows[0].id, user.rows[0].id, attachment.rows[0].id],
    )
    await pool.query('update attachments set entity_id=$2 where id=$1', [
      attachment.rows[0].id,
      payment.rows[0].id,
    ])
    return {
      attachmentId: attachment.rows[0].id,
      objectId: proofId,
      objectKey,
      proofBytes,
      proofPath,
    }
  } finally {
    await pool.end()
  }
}

async function dumpDatabase(containerId, user, database, destination) {
  const child = spawn(
    'docker',
    [
      'exec',
      containerId,
      'pg_dump',
      '-U',
      user,
      '--no-owner',
      '--no-acl',
      '--format=custom',
      `--dbname=${database}`,
    ],
    { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 })
  const stderr = collect(child.stderr)
  child.stdout.pipe(output)
  await Promise.all([waitForExit(child, stderr), waitForFinish(output)])
}

async function restoreDatabase(containerId, user, database, dumpPath) {
  const child = spawn(
    'docker',
    [
      'exec',
      '-i',
      containerId,
      'pg_restore',
      '-U',
      user,
      '--exit-on-error',
      '--no-owner',
      '--no-acl',
      `--dbname=${database}`,
    ],
    { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const stderr = collect(child.stderr)
  child.stdout.resume()
  createReadStream(dumpPath).pipe(child.stdin)
  await waitForExit(child, stderr)
}

async function verifyRestoredReferences(connectionString, attachmentId) {
  const pool = new Pool({ connectionString })
  try {
    const result = await pool.query(
      `select a.object_key as "objectKey",a.file_size as "fileSize",a.entity_id::text as "entityId",
              p.id::text as "paymentId",(select count(*)::int from drizzle.__drizzle_migrations) as "migrationCount"
       from attachments a join payments p on p.payment_proof_attachment_id=a.id
       where a.id=$1 and a.entity_type='payment' and a.entity_id=p.id`,
      [attachmentId],
    )
    const recovered = result.rows[0]
    if (!recovered || recovered.entityId !== recovered.paymentId)
      throw new Error('The restored payment does not reference its restored proof metadata.')
    return recovered
  } finally {
    await pool.end()
  }
}

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = collect(child.stdout)
    const stderr = collect(child.stderr)
    child.on('error', reject)
    child.on('close', (code) => {
      const output = { stdout: stdout(), stderr: stderr() }
      if (code === 0) resolve(output)
      else reject(new Error(`${command} failed (${code ?? 'unknown exit code'}): ${output.stderr}`))
    })
  })
}

function collect(stream) {
  const chunks = []
  stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
  return () => Buffer.concat(chunks).toString('utf8')
}

function waitForExit(child, stderr) {
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else
        reject(
          new Error(`PostgreSQL backup/restore command failed (${code ?? 'unknown'}): ${stderr()}`),
        )
    })
  })
}

function waitForFinish(stream) {
  return new Promise((resolve, reject) => {
    stream.on('error', reject)
    stream.on('finish', resolve)
  })
}

function fail(message) {
  console.error(message)
  process.exit(2)
}
