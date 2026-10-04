import { Client } from 'pg'

const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
const sourceDatabaseNames = new Set(['cbms_dev', 'cbms_test'])
// Keep connection routing entirely in the URL authority/path. In particular, pg
// accepts ?host= as an override even when the URL itself names localhost.
const allowedQueryOptions = new Set(['ssl', 'sslmode', 'channel_binding', 'application_name'])

export function assertLocalTestDatabase(connectionString) {
  return assertDatabaseTarget(
    connectionString,
    (name) => sourceDatabaseNames.has(name),
    'Refusing disposable test database creation unless DATABASE_URL targets loopback cbms_dev or cbms_test.',
  )
}

export function assertIntegrationTestDatabase(connectionString) {
  return assertDatabaseTarget(
    connectionString,
    (name) => /^cbms_(?:test|integration_[a-z0-9_]+)$/.test(name),
    'Refusing integration tests unless DATABASE_URL targets loopback cbms_test or cbms_integration_*.',
  )
}

// Called by the Vitest config as well as the runner, so invoking Vitest directly
// cannot bypass the same target policy before test modules create a pool.
export function assertIntegrationTestEnvironment(environment = process.env) {
  if (environment.NODE_ENV !== 'test') {
    throw new Error('Integration tests require NODE_ENV=test.')
  }
  return assertIntegrationTestDatabase(environment.DATABASE_URL)
}

function assertDatabaseTarget(connectionString, allowsDatabaseName, refusalMessage) {
  let url
  let databaseName

  try {
    url = new URL(connectionString)
    databaseName = decodeURIComponent(url.pathname.slice(1))
  } catch {
    throw new Error('The local test database must be a valid PostgreSQL URL.')
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('The local test database must use PostgreSQL.')
  }

  const hostname = normalizeHost(url.hostname)

  if (!localHosts.has(hostname) || !allowsDatabaseName(databaseName) || url.hash) {
    throw new Error(refusalMessage)
  }

  if ([...url.searchParams.keys()].some((key) => !allowedQueryOptions.has(key))) {
    throw new Error(
      'Test database URLs cannot contain connection routing or unsupported query options.',
    )
  }
  if (process.env.NODE_PG_FORCE_NATIVE) {
    throw new Error('Local test database verification requires the standard node-postgres driver.')
  }

  // Make the default port explicit rather than inheriting a different PGPORT.
  url.port ||= '5432'
  let effective
  try {
    // Construction parses configuration only: no socket is opened.
    effective = new Client({ connectionString: url.href }).connectionParameters
  } catch {
    throw new Error('The local test database connection options are invalid.')
  }
  if (
    normalizeHost(effective.host) !== hostname ||
    effective.database !== databaseName ||
    effective.port !== Number(url.port)
  ) {
    throw new Error(refusalMessage)
  }

  return url
}

function normalizeHost(hostname) {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase()
}
