import { expect, it } from 'vitest'
import { assertDatabaseReady } from '@/database/readiness.js'

it('accepts the repository migrations applied by the disposable database runner', async () => {
  await expect(assertDatabaseReady()).resolves.toBeUndefined()
})
