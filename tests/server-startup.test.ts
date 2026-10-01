import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('exits without listening when PostgreSQL cannot be reached', () => {
  const result = spawnSync(
    process.execPath,
    ['--import=./scripts/node-compat.mjs', '--import=tsx', 'src/server.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/cbms_test',
        SESSION_SECRET: 'test-only-session-secret-with-32-characters',
        R2_ACCOUNT_ID: '',
        R2_ACCESS_KEY_ID: '',
        R2_SECRET_ACCESS_KEY: '',
        R2_BUCKET_NAME: '',
      },
      encoding: 'utf8',
      timeout: 12_000,
    },
  )

  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stdout).not.toContain('API listening')
  expect(result.stderr).toContain('CBMS API startup failed (DATABASE_UNAVAILABLE)')
  expect(result.stderr).not.toContain('postgresql://')
  expect(result.stderr).not.toContain('ECONNREFUSED')
}, 15_000)
