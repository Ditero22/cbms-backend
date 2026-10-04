import { spawnSync } from 'node:child_process'
import { Client } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertIntegrationTestDatabase,
  assertIntegrationTestEnvironment,
  assertLocalTestDatabase,
} from '../scripts/local-test-database.mjs'

afterEach(() => vi.unstubAllEnvs())

describe('assertLocalTestDatabase', () => {
  it('accepts loopback cbms_dev PostgreSQL URLs', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(assertLocalTestDatabase(`postgresql://test:test@${host}:5433/cbms_dev`).pathname).toBe(
        '/cbms_dev',
      )
    }
  })

  it('accepts loopback cbms_test PostgreSQL URLs for disposable CI services', () => {
    expect(
      assertLocalTestDatabase('postgresql://test:test@127.0.0.1:5432/cbms_test').pathname,
    ).toBe('/cbms_test')
  })

  it('rejects remote PostgreSQL hosts', () => {
    expect(() =>
      assertLocalTestDatabase('postgresql://test:test@example.invalid/cbms_dev'),
    ).toThrow(/loopback cbms_dev or cbms_test/)
  })

  it('rejects unapproved databases even on loopback', () => {
    expect(() =>
      assertLocalTestDatabase('postgresql://test:test@127.0.0.1:5433/cbms_other'),
    ).toThrow(/loopback cbms_dev or cbms_test/)
  })

  it('rejects non-PostgreSQL and malformed URLs', () => {
    expect(() => assertLocalTestDatabase('https://example.invalid/cbms_dev')).toThrow(/PostgreSQL/)
    expect(() => assertLocalTestDatabase('not-a-url')).toThrow(/valid PostgreSQL URL/)
  })

  it.each([
    'host=example.invalid',
    'host=localhost&host=example.invalid',
    '%68ost=example.invalid',
    'HOST=example.invalid',
    'hostaddr=192.0.2.1',
    'port=5432',
    'database=cbms_prod',
    'dbname=cbms_prod',
    'service=hosted',
    'servicefile=remote.conf',
    'sslrootcert=private-file',
  ])('rejects connection query overrides before the driver parses them: %s', (query) => {
    expect(() =>
      assertLocalTestDatabase(`postgresql://test:test@localhost:5433/cbms_dev?${query}`),
    ).toThrow(/routing or unsupported/)
  })

  it.each([
    'postgresql://test:test@localhost,example.invalid/cbms_dev',
    'postgresql://test:test@%2Ftmp/cbms_dev',
    'postgresql:///cbms_dev',
    'postgresql://test:test@example%2Einvalid/cbms_dev',
    'postgresql://test:test@localhost/cbms_dev%2Fother',
    'postgresql://test:test@localhost/cbms_dev#other',
  ])('rejects ambiguous, socket, multi-host, and nonlocal routing', (candidate) => {
    expect(() => assertLocalTestDatabase(candidate)).toThrow()
  })

  it('pins the actual pg target even with conflicting ambient PostgreSQL variables', () => {
    vi.stubEnv('PGHOST', 'example.invalid')
    vi.stubEnv('PGDATABASE', 'cbms_prod')
    vi.stubEnv('PGPORT', '6543')
    const verified = assertLocalTestDatabase(
      'postgresql://test:test@localhost/cbms_dev?sslmode=disable&application_name=qa',
    )
    const effective = new Client({ connectionString: verified.href }).connectionParameters
    expect(effective).toMatchObject({ host: 'localhost', database: 'cbms_dev', port: 5432 })
    expect(assertLocalTestDatabase('postgresql://test:test@127.0.0.1:5433/cbms_dev').port).toBe(
      '5433',
    )
  })

  it('does not expose invalid connection strings in diagnostic errors', () => {
    const candidate = 'postgresql://private-user:private-password@localhost/cbms_%ZZ'
    try {
      assertLocalTestDatabase(candidate)
      throw new Error('Expected refusal')
    } catch (error) {
      expect(String(error)).not.toContain('private-user')
      expect(String(error)).not.toContain('private-password')
      expect(String(error)).toMatch(/valid PostgreSQL URL/)
    }
  })
})

describe('integration target policy', () => {
  it('accepts only local disposable targets, excluding the development source database', () => {
    for (const name of [
      'cbms_test',
      'cbms_integration_abc123',
      'cbms_integration_browser_abc123',
    ]) {
      expect(
        assertIntegrationTestDatabase(`postgresql://test:test@127.0.0.1:5433/${name}`).pathname,
      ).toBe(`/${name}`)
    }
    for (const candidate of [
      'postgresql://test:test@127.0.0.1:5433/cbms_dev',
      'postgresql://test:test@example.invalid/cbms_test',
      'postgresql://test:test@localhost/cbms_integration_',
      'postgresql://test:test@localhost/cbms_test?host=example.invalid',
    ]) {
      expect(() => assertIntegrationTestDatabase(candidate)).toThrow()
    }
  })

  it('requires test mode and validates DATABASE_URL before direct Vitest execution', () => {
    const url = 'postgresql://test:test@localhost/cbms_test'
    expect(() =>
      assertIntegrationTestEnvironment({ NODE_ENV: 'production', DATABASE_URL: url }),
    ).toThrow(/NODE_ENV=test/)
    expect(() =>
      assertIntegrationTestEnvironment({ NODE_ENV: 'test', DATABASE_URL: url }),
    ).not.toThrow()
    expect(() => assertIntegrationTestEnvironment({ NODE_ENV: 'test' })).toThrow()
  })

  it.each([
    ['scripts/run-integration-tests.mjs', 'cbms_test'],
    ['scripts/run-local-integration-tests.mjs', 'cbms_dev'],
    ['scripts/run-browser-tests.mjs', 'cbms_dev'],
    ['scripts/rehearse-disposable-restore.mjs', 'cbms_dev'],
  ])('refuses a routing override at the %s entry point before work begins', (script, database) => {
    const unsafeUrl = `postgresql://private-user:private-password@localhost/${database}?host=example.invalid`
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, DATABASE_URL: unsafeUrl, TEST_DATABASE_URL: unsafeUrl },
    })
    const output = `${result.stdout}${result.stderr}`
    expect(result.status).not.toBe(0)
    expect(output).toMatch(/routing or unsupported/)
    expect(output).not.toContain('private-password')
    expect(output).not.toMatch(/ENOTFOUND|Database migrations are up to date/)
  })

  it('rejects a hosted database when importing the integration config directly', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import=tsx',
        '--input-type=module',
        '--eval',
        "await import('./vitest.integration.config.ts')",
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://private-user:private-password@example.invalid/cbms_test',
        },
      },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/loopback cbms_test or cbms_integration_/)
    expect(result.stderr).not.toContain('private-password')
  })

  it.each([
    ['example.invalid/cbms_integration_browser_abc123', /loopback/],
    ['localhost/cbms_integration_browser_abc123?host=example.invalid', /routing or unsupported/],
    ['localhost/cbms_test', /disposable browser-test database/],
  ])('guards direct browser fixture invocation before loading the pool: %s', (target, refusal) => {
    const result = spawnSync(
      process.execPath,
      ['--import=./scripts/node-compat.mjs', '--import=tsx', 'tests/browser/seed.ts'],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: `postgresql://private-user:private-password@${target}`,
        },
      },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(refusal)
    expect(result.stderr).not.toContain('private-password')
    expect(result.stderr).not.toMatch(/ENOTFOUND|ECONNREFUSED/)
  })
})
