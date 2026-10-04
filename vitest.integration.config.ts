import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { assertIntegrationTestEnvironment } from './scripts/local-test-database.mjs'

process.env.DATABASE_URL = assertIntegrationTestEnvironment().href

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
})
