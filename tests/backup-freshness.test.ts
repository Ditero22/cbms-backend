import { describe, expect, it, vi } from 'vitest'
import { assessBackupFreshness, checkBackupFreshness } from '../scripts/check-backup-freshness.mjs'

const now = Date.parse('2026-10-06T08:00:00Z')
const run = {
  id: 123,
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  event: 'schedule',
  created_at: '2026-10-05T08:00:00Z',
}

describe('staging backup freshness', () => {
  it('accepts the 24-hour boundary but fails immediately after it', () => {
    expect(assessBackupFreshness([run], now)).toMatchObject({ status: 'fresh', ageHours: 24 })
    expect(assessBackupFreshness([run], now + 1)).toMatchObject({ status: 'stale' })
  })

  it('does not count failed, unfinished, foreign-branch or pull-request runs', () => {
    for (const change of [
      { conclusion: 'failure' },
      { status: 'in_progress' },
      { head_branch: 'preview' },
      { event: 'pull_request' },
    ])
      expect(assessBackupFreshness([{ ...run, ...change }], now).status).toBe('missing')
  })

  it('uses the newest eligible success and permits controlled manual backups', () => {
    expect(
      assessBackupFreshness(
        [
          run,
          { ...run, id: 456, event: 'workflow_dispatch', created_at: '2026-10-06T07:00:00Z' },
          { ...run, id: 789, conclusion: 'failure', created_at: '2026-10-06T07:30:00Z' },
        ],
        now,
      ),
    ).toMatchObject({ status: 'fresh', runId: 456, ageHours: 1 })
  })

  it('fails closed for missing, malformed and future-dated evidence', () => {
    expect(assessBackupFreshness([], now).status).toBe('missing')
    expect(assessBackupFreshness(null, now).status).toBe('unavailable')
    for (const created_at of ['invalid', '2026-10-07T00:00:00Z'])
      expect(assessBackupFreshness([{ ...run, created_at }], now).status).toBe('unavailable')
  })

  it('requests only this backup workflow and does not return its token', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ workflow_runs: [run] }) })
    const result = await checkBackupFreshness({ GITHUB_TOKEN: 'synthetic-token' }, request, now)
    expect(result.status).toBe('fresh')
    expect(request.mock.calls[0][0]).toContain(
      '/cbms-backend/actions/workflows/staging-daily-backup.yml/runs?branch=main&status=success',
    )
    expect(request.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      headers: { Authorization: 'Bearer synthetic-token' },
    })
    expect(JSON.stringify(result)).not.toContain('synthetic-token')
    await expect(
      checkBackupFreshness({ GITHUB_REPOSITORY: 'other/repo' }, request, now),
    ).rejects.toThrow('restricted')
    expect(request).toHaveBeenCalledOnce()
  })

  it('reports an unavailable check without exposing provider errors or response bodies', async () => {
    const privateMessage = 'synthetic credential detail'
    for (const response of [
      vi.fn().mockRejectedValue(new Error(privateMessage)),
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ message: privateMessage }) }),
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error(privateMessage)
        },
      }),
    ]) {
      const result = await checkBackupFreshness({}, response, now)
      expect(result.status).toBe('unavailable')
      expect(JSON.stringify(result)).not.toContain(privateMessage)
    }
  })
})
