import path from 'node:path'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { db, pool } from './client.js'

try {
  await migrate(db, { migrationsFolder: path.resolve('drizzle') })
  console.info('Database migrations are up to date.')
} finally {
  await pool.end()
}
