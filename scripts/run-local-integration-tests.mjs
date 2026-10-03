import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { Client } from 'pg'
import { assertLocalTestDatabase } from './local-test-database.mjs'

const sourceDatabaseUrl = process.env.DATABASE_URL
if (!sourceDatabaseUrl) {
  console.error('DATABASE_URL is required to create a disposable local integration database.')
  process.exit(2)
}

let sourceUrl
try {
  sourceUrl = assertLocalTestDatabase(sourceDatabaseUrl)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid local test database target.')
  process.exit(2)
}

const databaseName = `cbms_integration_${randomBytes(6).toString('hex')}`
const adminUrl = new URL(sourceUrl)
adminUrl.pathname = '/postgres'
const testUrl = new URL(sourceUrl)
testUrl.pathname = `/${databaseName}`
const admin = new Client({ connectionString: adminUrl.href })

await admin.connect()
try {
  await admin.query(`create database ${databaseName}`)
  const result = spawnSync(
    process.execPath,
    ['scripts/run-integration-tests.mjs', ...process.argv.slice(2)],
    {
      env: { ...process.env, TEST_DATABASE_URL: testUrl.href },
      stdio: 'inherit',
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
} finally {
  await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1', [
    databaseName,
  ])
  await admin.query(`drop database ${databaseName}`)
  await admin.end()
}
