import { HeadBucketCommand } from '@aws-sdk/client-s3'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function getR2ReadinessConfig(env = process.env) {
  const accountId = env.STAGING_R2_ACCOUNT_ID?.trim()
  const accessKeyId = env.STAGING_R2_ACCESS_KEY_ID?.trim()
  const secretAccessKey = env.STAGING_R2_SECRET_ACCESS_KEY
  const bucket = env.STAGING_R2_BUCKET_NAME?.trim()

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    const error = new Error('Staging R2 readiness configuration is incomplete.')
    error.code = 'R2_CONFIG_INCOMPLETE'
    throw error
  }

  return {
    bucket,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  }
}

export async function checkR2Bucket(client, bucket) {
  if (!client || !bucket) throw new Error('R2 client and bucket are required.')
  await client.send(new HeadBucketCommand({ Bucket: bucket }))
}

export function getSafeR2FailureCategory(error) {
  if (error?.code === 'R2_CONFIG_INCOMPLETE') return 'local staging R2 settings unavailable'
  const status = error?.$metadata?.httpStatusCode
  const name = error?.name
  if (status === 401 || status === 403 || name === 'AccessDenied') return 'access or token scope'
  if (status === 404 || name === 'NoSuchBucket' || name === 'NotFound') return 'bucket not found'
  if (name === 'TimeoutError' || name === 'AbortError' || name === 'NetworkingError')
    return 'network or timeout'
  if (typeof status === 'number' && status >= 500) return 'Cloudflare service error'
  return 'configuration or bucket check unavailable'
}

export async function runR2Readiness(env = process.env, createClient) {
  const config = getR2ReadinessConfig(env)
  if (typeof createClient !== 'function') throw new Error('R2 client factory is required.')
  const client = createClient(config)
  try {
    await checkR2Bucket(client, config.bucket)
  } finally {
    client.destroy?.()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { S3Client } = await import('@aws-sdk/client-s3')
  try {
    await runR2Readiness(
      process.env,
      (config) =>
        new S3Client({
          region: 'auto',
          endpoint: config.endpoint,
          credentials: config.credentials,
          maxAttempts: 2,
        }),
    )
    console.info('staging R2 bucket readiness: PASS')
  } catch (error) {
    console.error(`staging R2 bucket readiness: FAIL (${getSafeR2FailureCategory(error)})`)
    process.exitCode = 1
  }
}
