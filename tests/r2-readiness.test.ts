import { describe, expect, it, vi } from 'vitest'
import {
  getR2ReadinessConfig,
  getSafeR2FailureCategory,
  runR2Readiness,
} from '../scripts/r2-readiness.mjs'

const validEnv = {
  STAGING_R2_ACCOUNT_ID: 'account-id',
  STAGING_R2_ACCESS_KEY_ID: 'access-key',
  STAGING_R2_SECRET_ACCESS_KEY: 'secret-key',
  STAGING_R2_BUCKET_NAME: 'cbms-storage',
}

describe('staging R2 readiness', () => {
  it('builds the R2 endpoint without exposing credentials in it', () => {
    expect(getR2ReadinessConfig(validEnv)).toEqual({
      bucket: 'cbms-storage',
      endpoint: 'https://account-id.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
    })
  })

  it('fails closed when any required staging setting is absent', () => {
    for (const key of Object.keys(validEnv)) {
      const env = { ...validEnv }
      delete env[key as keyof typeof validEnv]
      expect(() => getR2ReadinessConfig(env)).toThrow('configuration is incomplete')
    }
  })

  it('issues only a bucket-head check and closes the client', async () => {
    const send = vi.fn().mockResolvedValue({})
    const destroy = vi.fn()
    const factory = vi.fn(() => ({ send, destroy }))

    await runR2Readiness(validEnv, factory)

    expect(factory).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: 'cbms-storage' })
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('closes the client after a failed bucket check', async () => {
    const destroy = vi.fn()
    const factory = vi.fn(() => ({
      send: vi.fn().mockRejectedValue(new Error('private SDK detail')),
      destroy,
    }))

    await expect(runR2Readiness(validEnv, factory)).rejects.toThrow('private SDK detail')
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('reports safe failure categories without exposing provider messages', () => {
    expect(getSafeR2FailureCategory({ $metadata: { httpStatusCode: 403 } })).toBe(
      'access or token scope',
    )
    expect(getSafeR2FailureCategory({ $metadata: { httpStatusCode: 404 } })).toBe(
      'bucket not found',
    )
    expect(getSafeR2FailureCategory({ code: 'R2_CONFIG_INCOMPLETE' })).toBe(
      'local staging R2 settings unavailable',
    )
    expect(
      getSafeR2FailureCategory({ name: 'NetworkingError', message: 'credential detail' }),
    ).toBe('network or timeout')
    expect(getSafeR2FailureCategory({ name: 'OddError', message: 'credential detail' })).toBe(
      'configuration or bucket check unavailable',
    )
  })
})
