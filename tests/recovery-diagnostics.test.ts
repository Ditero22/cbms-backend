import { describe, expect, it } from 'vitest'
import { classifyPgClientFailure } from '../scripts/recovery-diagnostics.mjs'

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
