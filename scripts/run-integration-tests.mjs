import { spawnSync } from 'node:child_process'
import { createTestProofStorage } from './test-proof-storage.mjs'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
if (!testDatabaseUrl) {
  console.error('Set TEST_DATABASE_URL to a dedicated, disposable PostgreSQL test database.')
  process.exit(2)
}

let databaseName
try {
  const url = new URL(testDatabaseUrl)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid protocol')
  databaseName = decodeURIComponent(url.pathname.slice(1))
} catch {
  console.error('TEST_DATABASE_URL must be a valid PostgreSQL URL.')
  process.exit(2)
}

if (!/^cbms_(?:test|integration_[a-z0-9_]+)$/.test(databaseName)) {
  console.error('Refusing to run integration tests outside cbms_test or cbms_integration_*.')
  process.exit(2)
}

const proofStorage = createTestProofStorage()
const environment = {
  ...process.env,
  ...proofStorage.environment,
  DATABASE_URL: testDatabaseUrl,
  NODE_ENV: 'test',
  SESSION_SECRET: 'integration-test-only-session-secret-32-chars',
  // The HTTP acceptance suite intentionally makes many requests from one loopback address.
  RATE_LIMIT_MAX: '500',
  AUTH_RATE_LIMIT_MAX: '500',
}

function run(args) {
  const result = spawnSync(process.execPath, args, { env: environment, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
    throw new Error('Integration verification failed.')
  }
}

try {
  run(['--import=./scripts/node-compat.mjs', '--import=tsx', 'src/database/migrate.ts'])
  run([
    './node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'vitest.integration.config.ts',
    ...process.argv.slice(2),
  ])
} finally {
  proofStorage.cleanup()
}
