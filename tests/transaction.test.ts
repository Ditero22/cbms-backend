import { beforeEach, expect, it, vi } from 'vitest'

const { query, release } = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }))
vi.mock('@/database/client.js', () => ({ pool: { connect: async () => ({ query, release }) } }))
import { TransactionCommitError, withTransaction } from '@/database/transaction.js'

beforeEach(() => {
  vi.resetAllMocks()
  query.mockResolvedValue({ rows: [] })
})

it('commits successful work and returns its result', async () => {
  expect(await withTransaction(async () => 'saved')).toBe('saved')
  expect(query.mock.calls.map(([sql]) => sql)).toEqual(['begin', 'commit'])
  expect(release).toHaveBeenCalledWith(false)
})

it('preserves the operation failure and discards a connection when rollback fails', async () => {
  const failure = new Error('operation failed')
  query.mockImplementation(async (sql) => {
    if (sql === 'rollback') throw new Error('rollback lost')
  })
  await expect(
    withTransaction(async () => {
      throw failure
    }),
  ).rejects.toBe(failure)
  expect(release).toHaveBeenCalledWith(true)
})

it('classifies an uncertain commit without exposing its raw diagnostic message', async () => {
  query.mockImplementation(async (sql) => {
    if (sql === 'commit') throw new Error('synthetic-private-database-detail')
  })
  await expect(withTransaction(async () => 'saved')).rejects.toBeInstanceOf(TransactionCommitError)
  await expect(withTransaction(async () => 'saved')).rejects.toThrow(
    'The transaction result could not be confirmed.',
  )
  expect(release).toHaveBeenCalledWith(true)
})
