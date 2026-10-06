import console from 'node:console'
import process from 'node:process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const maxAgeMs = 24 * 60 * 60 * 1000

// Run creation predates its snapshot. This deliberately conservative age does
// not equate a successful workflow with verified restoration or retention.
export function assessBackupFreshness(runs, now = Date.now()) {
  if (!Array.isArray(runs) || !Number.isFinite(now))
    return { status: 'unavailable', reason: 'Invalid backup metadata.' }
  const successful = runs.filter(
    (run) =>
      run?.head_branch === 'main' &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      ['schedule', 'workflow_dispatch'].includes(run.event),
  )
  if (!successful.length) return { status: 'missing', reason: 'No successful main backup found.' }
  const dates = successful.map((run) => ({ run, created: Date.parse(run.created_at) }))
  if (
    dates.some(
      ({ run, created }) =>
        !Number.isSafeInteger(run.id) || !Number.isFinite(created) || created > now,
    )
  )
    return { status: 'unavailable', reason: 'Invalid backup timestamps or run identifiers.' }
  const latest = dates.sort((a, b) => b.created - a.created)[0]
  const ageMs = now - latest.created
  return {
    status: ageMs <= maxAgeMs ? 'fresh' : 'stale',
    runId: latest.run.id,
    ageHours: Math.round((ageMs / 3600000) * 100) / 100,
    limitHours: 24,
  }
}

export async function checkBackupFreshness(
  env = process.env,
  request = globalThis.fetch,
  now = Date.now(),
) {
  const repository = env.GITHUB_REPOSITORY || 'Ditero22/cbms-backend'
  if (!/^Ditero22\/cbms-backend$/i.test(repository))
    throw new Error('The backup monitor is restricted to the CBMS backend repository.')
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`
  try {
    const response = await request(
      `https://api.github.com/repos/${repository}/actions/workflows/staging-daily-backup.yml/runs?branch=main&status=success&per_page=100`,
      { headers, redirect: 'error', signal: globalThis.AbortSignal.timeout(15000) },
    )
    if (!response.ok) throw new Error('Unavailable')
    return assessBackupFreshness((await response.json()).workflow_runs, now)
  } catch {
    // Provider response bodies and tokens must never appear in CI output.
    return { status: 'unavailable', reason: 'Backup metadata could not be verified.' }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await checkBackupFreshness()
    console.info(`staging backup freshness: ${JSON.stringify(result)}`)
    if (result.status !== 'fresh') process.exitCode = 1
  } catch {
    console.error('staging backup freshness: configuration unavailable')
    process.exitCode = 1
  }
}
