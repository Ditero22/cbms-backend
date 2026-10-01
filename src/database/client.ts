import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { env } from '@/config/env.js'
import { errorDiagnostics } from '@/shared/diagnostics.js'
import * as schema from './schema.js'

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: env.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
  application_name: 'cbms-api',
})

pool.on('error', (error) => {
  console.error('Unexpected idle PostgreSQL client error', errorDiagnostics(error))
})

export const db = drizzle(pool, { schema })
