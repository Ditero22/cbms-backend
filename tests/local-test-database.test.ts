import { describe, expect, it } from 'vitest'
import { assertLocalTestDatabase } from '../scripts/local-test-database.mjs'

describe('assertLocalTestDatabase', () => {
  it('accepts loopback cbms_dev PostgreSQL URLs', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(assertLocalTestDatabase(`postgresql://test:test@${host}:5433/cbms_dev`).pathname).toBe(
        '/cbms_dev',
      )
    }
  })

  it('rejects remote PostgreSQL hosts', () => {
    expect(() =>
      assertLocalTestDatabase('postgresql://test:test@example.invalid/cbms_dev'),
    ).toThrow(/loopback cbms_dev/)
  })

  it('rejects non-development databases even on loopback', () => {
    expect(() =>
      assertLocalTestDatabase('postgresql://test:test@127.0.0.1:5433/cbms_test'),
    ).toThrow(/loopback cbms_dev/)
  })

  it('rejects non-PostgreSQL and malformed URLs', () => {
    expect(() => assertLocalTestDatabase('https://example.invalid/cbms_dev')).toThrow(/PostgreSQL/)
    expect(() => assertLocalTestDatabase('not-a-url')).toThrow(/valid PostgreSQL URL/)
  })
})
