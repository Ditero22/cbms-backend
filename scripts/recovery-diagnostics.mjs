export function classifyPgClientFailure(output) {
  if (/server version mismatch|server version .* does not match/i.test(output))
    return 'PostgreSQL client/server versions are incompatible'
  if (/permission denied/i.test(output))
    return 'database role lacks required dump or restore privileges'
  if (/password authentication failed|authentication failed/i.test(output))
    return 'database authentication was rejected'
  if (
    /snapshot.{0,100}(does not exist|not found|could not be imported)|could not import snapshot/i.test(
      output,
    )
  )
    return 'the exported database snapshot could not be reused by the PostgreSQL client'
  if (/certificate|ssl error|tls/i.test(output)) return 'database TLS verification failed'
  if (
    /could not connect|connection timed out|connection refused|network is unreachable/i.test(output)
  )
    return 'database network connection failed'
  return 'PostgreSQL utility rejected the dump or restore request'
}

export function createPgClientEnvironment(url, inheritedEnvironment = process.env) {
  const env = { ...inheritedEnvironment }
  env.PGHOST = url.hostname
  env.PGPORT = url.port || '5432'
  env.PGUSER = decodeURIComponent(url.username)
  env.PGPASSWORD = decodeURIComponent(url.password)
  env.PGDATABASE = decodeURIComponent(url.pathname.slice(1))
  env.PGSSLMODE = 'verify-full'
  env.PGSSLROOTCERT = 'system'
  const channelBinding = url.searchParams.get('channel_binding')
  if (channelBinding) env.PGCHANNELBINDING = channelBinding
  env.PGCONNECT_TIMEOUT = '15'
  return env
}
