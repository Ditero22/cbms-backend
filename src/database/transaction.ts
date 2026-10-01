import type { PoolClient } from 'pg'
import { pool } from './client.js'

export class TransactionCommitError extends Error {
  constructor(cause: unknown) {
    super('The transaction result could not be confirmed. Retry the unchanged request.', { cause })
    this.name = 'TransactionCommitError'
  }
}

export async function withTransaction<T>(operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect()
  let committing = false
  let discardClient = false

  try {
    await client.query('begin')
    const result = await operation(client)
    committing = true
    await client.query('commit')
    return result
  } catch (error) {
    discardClient = committing
    try {
      await client.query('rollback')
    } catch {
      discardClient = true
    }
    throw committing ? new TransactionCommitError(error) : error
  } finally {
    client.release(discardClient)
  }
}
