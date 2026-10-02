import { z } from 'zod'
import { passwordSchema } from '@/shared/security/password-policy.js'

const integerFromString = (fallback: number) => z.coerce.number().int().positive().default(fallback)

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: integerFromString(3000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must contain at least 32 characters'),
    AUTH_MODE: z.enum(['session', 'jwt']).default('session'),
    JWT_ACCESS_SECRET: z.string().default(''),
    JWT_ISSUER: z.string().min(1).default('cbms-api'),
    JWT_AUDIENCE: z.string().min(1).default('cbms-web'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(300).max(900).default(600),
    FRONTEND_URL: z.url().default('http://localhost:5173'),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    COOKIE_DOMAIN: z.string().optional().default(''),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    RATE_LIMIT_WINDOW_MS: integerFromString(60_000),
    RATE_LIMIT_MAX: integerFromString(120),
    AUTH_RATE_LIMIT_MAX: integerFromString(10),
    PG_POOL_MAX: integerFromString(10),
    TRUST_PROXY: z.enum(['true', 'false']).default('false'),
    BOOTSTRAP_ADMIN_EMAIL: z.email().optional(),
    BOOTSTRAP_ADMIN_PASSWORD: passwordSchema.optional(),
    BOOTSTRAP_ADMIN_NAME: z.string().min(2).optional(),
    CBMS_SAMPLE_USER_PASSWORD: passwordSchema.optional(),
    R2_ACCOUNT_ID: z.string().optional().default(''),
    R2_ACCESS_KEY_ID: z.string().optional().default(''),
    R2_SECRET_ACCESS_KEY: z.string().optional().default(''),
    R2_BUCKET_NAME: z.string().optional().default(''),
    R2_PUBLIC_URL: z.string().optional().default(''),
    LOCAL_UPLOAD_DIR: z.string().min(1).default('.local/private-uploads'),
  })
  .superRefine((value, context) => {
    if (value.AUTH_MODE === 'jwt' && value.JWT_ACCESS_SECRET.length < 32) {
      context.addIssue({
        code: 'custom',
        path: ['JWT_ACCESS_SECRET'],
        message: 'JWT mode requires a separate random signing secret of at least 32 characters.',
      })
    }
    if (value.AUTH_MODE === 'jwt' && value.JWT_ACCESS_SECRET === value.SESSION_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['JWT_ACCESS_SECRET'],
        message: 'Use a signing secret distinct from SESSION_SECRET.',
      })
    }
    const storageValues = [
      value.R2_ACCOUNT_ID,
      value.R2_ACCESS_KEY_ID,
      value.R2_SECRET_ACCESS_KEY,
      value.R2_BUCKET_NAME,
    ]
    const configuredStorageCount = storageValues.filter(Boolean).length

    if (configuredStorageCount > 0 && configuredStorageCount < storageValues.length) {
      context.addIssue({
        code: 'custom',
        path: ['R2_BUCKET_NAME'],
        message: 'Set every R2 credential or leave all R2 values empty.',
      })
    }
  })

const result = environmentSchema.safeParse(process.env)

if (!result.success) {
  const issues = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('\n')
  throw new Error(`Invalid CBMS backend configuration:\n${issues}`)
}

const parsed = result.data

export const env = {
  nodeEnv: parsed.NODE_ENV,
  isProduction: parsed.NODE_ENV === 'production',
  isDevelopment: parsed.NODE_ENV === 'development',
  port: parsed.PORT,
  databaseUrl: parsed.DATABASE_URL,
  sessionSecret: parsed.SESSION_SECRET,
  authMode: parsed.AUTH_MODE,
  jwt: {
    secret: parsed.JWT_ACCESS_SECRET,
    issuer: parsed.JWT_ISSUER,
    audience: parsed.JWT_AUDIENCE,
    ttlSeconds: parsed.JWT_ACCESS_TTL_SECONDS,
  },
  frontendUrl: parsed.FRONTEND_URL,
  corsOrigins: new Set(
    parsed.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
  cookieDomain: parsed.COOKIE_DOMAIN || undefined,
  logLevel: parsed.LOG_LEVEL,
  rateLimitWindowMs: parsed.RATE_LIMIT_WINDOW_MS,
  rateLimitMax: parsed.RATE_LIMIT_MAX,
  authRateLimitMax: parsed.AUTH_RATE_LIMIT_MAX,
  poolMax: parsed.PG_POOL_MAX,
  trustProxy: parsed.TRUST_PROXY === 'true' ? 1 : false,
  bootstrapAdminEmail: (parsed.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@cbms.local').toLowerCase(),
  bootstrapAdminPassword: parsed.BOOTSTRAP_ADMIN_PASSWORD ?? '',
  bootstrapAdminName: parsed.BOOTSTRAP_ADMIN_NAME ?? 'CBMS Administrator',
  sampleUserPassword: parsed.CBMS_SAMPLE_USER_PASSWORD ?? '',
  localUploadDir: parsed.LOCAL_UPLOAD_DIR,
  r2: {
    accountId: parsed.R2_ACCOUNT_ID,
    accessKeyId: parsed.R2_ACCESS_KEY_ID,
    secretAccessKey: parsed.R2_SECRET_ACCESS_KEY,
    bucketName: parsed.R2_BUCKET_NAME,
    publicUrl: parsed.R2_PUBLIC_URL,
    enabled: Boolean(parsed.R2_ACCOUNT_ID),
  },
}
