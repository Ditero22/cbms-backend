import { describe, expect, it } from 'vitest'
import {
  classifyPgClientFailure,
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
