const localHosts = new Set(['localhost', '127.0.0.1', '::1'])

export function assertLocalTestDatabase(connectionString) {
  let url

  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('The local test database must be a valid PostgreSQL URL.')
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('The local test database must use PostgreSQL.')
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const databaseName = decodeURIComponent(url.pathname.slice(1))

  if (!localHosts.has(hostname) || databaseName !== 'cbms_dev') {
    throw new Error(
      'Refusing disposable test database creation unless DATABASE_URL targets loopback cbms_dev.',
    )
  }

  return url
}
