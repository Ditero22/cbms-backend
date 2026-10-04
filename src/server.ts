import app from './app.js'
import { env } from './config/env.js'
import { pool } from './database/client.js'
import { assertDatabaseReady } from './database/readiness.js'
import { AppError } from './shared/errors/AppError.js'

async function startServer() {
  await assertDatabaseReady()
  const server = app.listen(env.port, '0.0.0.0', () => {
    console.log(`Materials Supply Operations & Finance API listening on port ${env.port}`)
  })
  server.on('error', (error) => void failStartup(error))

  let shuttingDown = false
  function shutdown(signal: string) {
    if (shuttingDown) return
    shuttingDown = true
    console.info(`Received ${signal}; closing the server.`)
    const forceExit = setTimeout(() => process.exit(1), 10_000)
    forceExit.unref()
    server.close((error) => {
      void pool.end().then(
        () => process.exit(error ? 1 : 0),
        () => {
          console.error('The database pool could not close cleanly.')
          process.exit(1)
        },
      )
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

async function failStartup(error: unknown) {
  const code =
    error instanceof AppError
      ? error.code
      : typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'EADDRINUSE'
        ? 'PORT_IN_USE'
        : 'STARTUP_FAILED'
  const guidance =
    code === 'DATABASE_MIGRATIONS_REQUIRED'
      ? 'Back up and review the database, then run npm run db:migrate from cbms-backend.'
      : code === 'DATABASE_UNAVAILABLE'
        ? 'Check that PostgreSQL is running and the backend database connection settings are valid.'
        : code === 'MIGRATION_CONFIGURATION_ERROR'
          ? 'Restore the application migration files in the backend drizzle directory.'
          : code === 'PORT_IN_USE'
            ? 'Stop the other process using the configured API port or choose a different port.'
            : 'Review the backend configuration and application package.'
  console.error(`Materials Supply Operations & Finance API startup failed (${code}). ${guidance}`)
  process.exitCode = 1
  try {
    await pool.end()
  } catch {
    console.error('The database pool could not close cleanly.')
  }
}

await startServer().catch(failStartup)
