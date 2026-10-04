import { describe, expect, it } from 'vitest'
import {
  classifyMigrationFailure,
  classifyPgClientFailure,
  createMigrationEnvironment,
  createPgClientEnvironment,
} from '../scripts/recovery-diagnostics.mjs'

describe('classifyPgClientFailure', () => {
  it('classifies common PostgreSQL dump failures without returning raw output', () => {
    expect(classifyPgClientFailure('pg_dump: server version mismatch')).toBe(
      'PostgreSQL client/server versions are incompatible',
    )
    expect(classifyPgClientFailure('ERROR: permission denied for table customers')).toBe(
      'database role lacks required dump or restore privileges',
    )
    expect(classifyPgClientFailure('FATAL: password authentication failed for user private')).toBe(
      'database authentication was rejected',
    )
  })

  it('returns only a fixed safe category for unrecognized provider output', () => {
    const output = 'private-host user=secret password=never-print query=customer@example.invalid'

    expect(classifyPgClientFailure(output)).toBe(
      'PostgreSQL utility rejected the dump or restore request',
    )
  })
})

describe('createPgClientEnvironment', () => {
  it('uses system CA roots with full TLS verification for PostgreSQL 18 clients', () => {
    const inheritedEnvironment = { PATH: '/usr/bin', PGSSLMODE: 'disable' }
    const url = new URL(
      'postgresql://qa-user:qa-password@staging.example.invalid:5432/cbms?channel_binding=require',
    )
    const env = createPgClientEnvironment(url, inheritedEnvironment)

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      PGHOST: 'staging.example.invalid',
      PGPORT: '5432',
      PGUSER: 'qa-user',
      PGPASSWORD: 'qa-password',
      PGDATABASE: 'cbms',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: 'system',
      PGCHANNELBINDING: 'require',
      PGCONNECT_TIMEOUT: '15',
    })
    expect(inheritedEnvironment.PGSSLMODE).toBe('disable')
  })
})

describe('migration recovery diagnostics', () => {
  it('classifies migration failures into safe categories without echoing raw output', () => {
    expect(classifyMigrationFailure('SESSION_SECRET is missing')).toBe(
      'migration runner configuration is incomplete',
    )
    expect(classifyMigrationFailure('password authentication failed for user private')).toBe(
      'recovery database authentication was rejected',
    )
    expect(classifyMigrationFailure('permission denied for schema public')).toBe(
      'recovery database role lacks migration privileges',
    )
    expect(classifyMigrationFailure('could not connect to server: connection refused')).toBe(
      'recovery database connection failed',
    )
    expect(classifyMigrationFailure('private-host customer@example.invalid password=hidden')).toBe(
      'application migration failed; raw database details were suppressed',
    )
  })

  it('sets a short-lived configuration-only secret without changing inherited settings', () => {
    const inheritedEnvironment = {
      PATH: '/usr/bin',
      SESSION_SECRET: 'inherited-test-secret-that-must-not-be-reused',
    }
    const url = new URL('postgresql://qa-user:qa-password@recovery.example.invalid/cbms_recovery')
    const environment = createMigrationEnvironment(url, inheritedEnvironment)

    expect(environment.DATABASE_URL).toBe(url.href)
    expect(environment.PATH).toBe('/usr/bin')
    expect(environment.SESSION_SECRET).toMatch(/^[A-Za-z0-9_-]{64}$/)
    expect(environment.SESSION_SECRET).not.toBe(inheritedEnvironment.SESSION_SECRET)
    expect(inheritedEnvironment.SESSION_SECRET).toBe(
      'inherited-test-secret-that-must-not-be-reused',
    )
  })
})
