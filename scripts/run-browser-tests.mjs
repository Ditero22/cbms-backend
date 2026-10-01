import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from 'pg'
import { createTestProofStorage } from './test-proof-storage.mjs'

const backendDirectory = fileURLToPath(new URL('..', import.meta.url))
const frontendDirectory = resolve(backendDirectory, '../cbms-frontend')
const sourceDatabaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
if (!sourceDatabaseUrl) throw new Error('Set DATABASE_URL or TEST_DATABASE_URL for browser tests.')
const sourceUrl = new URL(sourceDatabaseUrl)
if (!['postgres:', 'postgresql:'].includes(sourceUrl.protocol)) {
  throw new Error('Browser tests require a PostgreSQL connection.')
}

const databaseName = `cbms_integration_browser_${randomBytes(6).toString('hex')}`
const adminUrl = new URL(sourceUrl)
adminUrl.pathname = '/postgres'
const testUrl = new URL(sourceUrl)
testUrl.pathname = `/${databaseName}`
const apiPort = readPort('CBMS_E2E_API_PORT', 3002)
const frontendPort = readPort('CBMS_E2E_FRONTEND_PORT', 5180)
const apiUrl = `http://127.0.0.1:${apiPort}`
const frontendUrl = `http://127.0.0.1:${frontendPort}`
const proofStorage = createTestProofStorage()
const environment = {
  ...process.env,
  ...proofStorage.environment,
  DATABASE_URL: testUrl.href,
  NODE_ENV: 'test',
  PORT: String(apiPort),
  FRONTEND_URL: frontendUrl,
  CORS_ORIGINS: frontendUrl,
  COOKIE_DOMAIN: '',
  LOG_LEVEL: 'silent',
  SESSION_SECRET: 'browser-test-only-session-secret-32-chars',
  RATE_LIMIT_MAX: '10000',
  AUTH_RATE_LIMIT_MAX: '1000',
  R2_ACCOUNT_ID: '',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
  R2_BUCKET_NAME: '',
  CBMS_E2E_API_URL: `${apiUrl}/api/v1`,
  CBMS_E2E_BASE_URL: frontendUrl,
  CBMS_E2E_PASSWORD: `Cbms-${randomBytes(24).toString('hex')}a!`,
  VITE_API_URL: `${apiUrl}/api/v1`,
}
const admin = new Client({ connectionString: adminUrl.href })
const children = new Set()
let createdDatabase = false

function readPort(name, fallback) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an unused port between 1024 and 65535.`)
  }
  return value
}

function runBackend(args, capture = false) {
  const result = spawnSync(process.execPath, args, {
    cwd: backendDirectory,
    env: environment,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Browser-test database preparation failed.')
  return result.stdout
}

function start(args, cwd) {
  const child = spawn(process.execPath, args, { cwd, env: environment, stdio: 'inherit' })
  children.add(child)
  child.once('error', (error) => console.error(error.message))
  child.once('exit', () => children.delete(child))
  return child
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error('A browser-test server exited before becoming ready.')
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
    } catch {
      // Startup readiness is checked again until the bounded deadline.
    }
    await delay(200)
  }
  throw new Error(`Browser-test server did not become ready at ${url}.`)
}

async function stopChildren() {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise((resolveStopped) => {
          child.once('exit', resolveStopped)
          child.kill()
        }),
    ),
  )
}

process.once('SIGINT', () => {
  for (const child of children) child.kill()
})
process.once('SIGTERM', () => {
  for (const child of children) child.kill()
})

await admin.connect()
try {
  await admin.query(`create database ${databaseName}`)
  createdDatabase = true
  runBackend(['--import=./scripts/node-compat.mjs', '--import=tsx', 'src/database/migrate.ts'])
  environment.CBMS_E2E_FIXTURES = runBackend(
    ['--import=./scripts/node-compat.mjs', '--import=tsx', 'tests/browser/seed.ts'],
    true,
  ).trim()
  const api = start(
    ['--import=./scripts/node-compat.mjs', '--import=tsx', 'src/server.ts'],
    backendDirectory,
  )
  const frontend = start(
    [
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      String(frontendPort),
      '--strictPort',
    ],
    frontendDirectory,
  )
  await Promise.all([
    waitForServer(`${apiUrl}/api/ready`, api),
    waitForServer(frontendUrl, frontend),
  ])
  const tests = start(
    ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)],
    frontendDirectory,
  )
  const exitCode = await new Promise((resolveExit) => tests.once('exit', resolveExit))
  process.exitCode = exitCode ?? 1
} finally {
  await stopChildren()
  if (createdDatabase) {
    await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1', [
      databaseName,
    ])
    await admin.query(`drop database ${databaseName}`)
  }
  await admin.end()
  proofStorage.cleanup()
}
