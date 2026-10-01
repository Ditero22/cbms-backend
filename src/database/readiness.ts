import path from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { AppError } from '@/shared/errors/AppError.js'
import { pool } from './client.js'

// The API and migration commands both run from the backend package directory.
// Checking the journal is read-only; startup never applies migrations implicitly.
export async function assertDatabaseReady() {
  let expectedTimestamps: number[]
  try {
    expectedTimestamps = readMigrationFiles({ migrationsFolder: path.resolve('drizzle') }).map(
      (migration) => migration.folderMillis,
    )
    if (
      expectedTimestamps.length === 0 ||
      expectedTimestamps.some((timestamp) => !Number.isSafeInteger(timestamp) || timestamp <= 0)
    ) {
      throw new Error('The migration journal is invalid.')
    }
  } catch {
    throw new AppError(
      503,
      'MIGRATION_CONFIGURATION_ERROR',
      'The service configuration is incomplete. Contact your administrator.',
    )
  }

  let appliedTimestamps: Set<number>
  try {
    const result = await pool.query<{ created_at: string }>(
      'select created_at from drizzle.__drizzle_migrations order by created_at',
    )
    appliedTimestamps = new Set(result.rows.map((migration) => Number(migration.created_at)))
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    if (code === '42P01' || code === '3F000') throw migrationsRequired()
    throw new AppError(
      503,
      'DATABASE_UNAVAILABLE',
      'The database service is temporarily unavailable. Try again shortly.',
    )
  }

  if (expectedTimestamps.some((timestamp) => !appliedTimestamps.has(timestamp))) {
    throw migrationsRequired()
  }
}

function migrationsRequired() {
  return new AppError(
    503,
    'DATABASE_MIGRATIONS_REQUIRED',
    'The database needs an application update. Contact your administrator.',
  )
}
