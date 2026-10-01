import { beforeEach, describe, expect, it, vi } from 'vitest'

const { query, readMigrationFiles } = vi.hoisted(() => ({
  query: vi.fn(),
  readMigrationFiles: vi.fn(),
}))

vi.mock('@/database/client.js', () => ({ pool: { query } }))
vi.mock('drizzle-orm/migrator', () => ({ readMigrationFiles }))

import { assertDatabaseReady } from '@/database/readiness.js'

beforeEach(() => {
  vi.resetAllMocks()
  readMigrationFiles.mockReturnValue([
    { folderMillis: 1000 },
    { folderMillis: 2000 },
    { folderMillis: 3000 },
  ])
})

describe('database readiness', () => {
  it('accepts an applied migration journal including PostgreSQL bigint strings', async () => {
    query.mockResolvedValue({
      rows: [{ created_at: '1000' }, { created_at: '2000' }, { created_at: '3000' }],
    })

    await expect(assertDatabaseReady()).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[0]).toMatch(
      /^select created_at from drizzle\.__drizzle_migrations/,
    )
  })

  it('rejects a connected database with pending migrations', async () => {
    query.mockResolvedValue({ rows: [{ created_at: '1000' }, { created_at: '2000' }] })

    await expect(assertDatabaseReady()).rejects.toMatchObject({
      status: 503,
      code: 'DATABASE_MIGRATIONS_REQUIRED',
    })
  })

  it('rejects a missing migration journal without trying to create it', async () => {
    query.mockRejectedValue({ code: '42P01', message: 'internal relation detail' })

    await expect(assertDatabaseReady()).rejects.toMatchObject({
      status: 503,
      code: 'DATABASE_MIGRATIONS_REQUIRED',
    })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('returns a safe service error when PostgreSQL is unavailable', async () => {
    query.mockRejectedValue(new Error('private connection configuration'))

    await expect(assertDatabaseReady()).rejects.toMatchObject({
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      message: 'The database service is temporarily unavailable. Try again shortly.',
    })
  })

  it('rejects missing packaged migration files before querying the database', async () => {
    readMigrationFiles.mockImplementation(() => {
      throw new Error('private application path')
    })

    await expect(assertDatabaseReady()).rejects.toMatchObject({
      status: 503,
      code: 'MIGRATION_CONFIGURATION_ERROR',
    })
    expect(query).not.toHaveBeenCalled()
  })
})
