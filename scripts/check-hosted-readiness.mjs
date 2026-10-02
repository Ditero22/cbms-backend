const origins = {
  frontend: process.env.CBMS_WEB_ORIGIN || 'https://cbms.dagami.workers.dev',
  backend: process.env.CBMS_API_ORIGIN || 'https://cbms-backend-staging.onrender.com',
}

for (const [name, value] of Object.entries(origins)) {
  const origin = new URL(value)
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(`Configure ${name} as an HTTPS origin without credentials or a path.`)
  }
}

const checks = [
  ['backend readiness', origins.backend, '/api/ready', 200],
  ['frontend API readiness', origins.frontend, '/api/ready', 200],
  ['signed-out authentication', origins.frontend, '/api/v1/auth/me', 401],
]
for (const [name, origin, path, expected] of checks) {
  try {
    const response = await fetch(`${origin}${path}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(55000),
    })
    const json = response.headers.get('content-type')?.includes('application/json')
    if (response.status !== expected || !json) throw new Error('Unexpected status or content type')
    await response.json()
    console.info(`${name}: PASS`)
  } catch {
    console.error(`${name}: FAIL (unavailable, unexpected status, or invalid JSON)`)
    process.exitCode = 1
  }
}
