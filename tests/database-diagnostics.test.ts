import { afterAll, expect, it, vi } from 'vitest'

vi.mock('@/config/env.js', () => ({
  env: { databaseUrl: 'postgresql://test:test@127.0.0.1:1/cbms_test', poolMax: 1 },
}))

import { pool } from '@/database/client.js'

afterAll(async () => {
  await pool.end()
})

it('sanitizes idle database failures through the registered pool error handler', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const error = Object.assign(new Error('synthetic-private-database-message'), {
    detail: 'Key (email)=(synthetic-private-person@example.invalid) already exists.',
    parameters: ['synthetic-private-parameter'],
    cause: new Error('synthetic-private-query'),
  })

  try {
    expect(pool.emit('error', error)).toBe(true)
    expect(log).toHaveBeenCalledExactlyOnceWith('Unexpected idle PostgreSQL client error', {
      errorType: 'InternalError',
      errorCode: 'INTERNAL_ERROR',
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private')
  } finally {
    log.mockRestore()
  }
})
