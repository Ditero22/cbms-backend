import { pool } from './client.js'

try {
  await pool.query('select 1')
  console.log('Database connection successful.')
} catch {
  console.error('Database connection failed. Check DATABASE_URL and network access.')
  process.exitCode = 1
} finally {
  await pool.end()
}
