import { z } from 'zod';

/**
 * Environment variables, validated once at start-up. Only what the foundation needs is listed here.
 * Each later module adds its own variables to this schema (Redis, JWT secrets, storage, payments ...).
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().url(),
  APP_ORIGINS: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  APP_VERSION: z.string().default('0.1.0'),
  // module 01 (adapters, queue, rate limit): Redis is optional; without it the in-process memory implementations are used
  REDIS_URL: z.string().url().optional(),
  PROVIDERS_MODE: z.enum(['real', 'fake']).default('fake'),
  // module 02 (authentication)
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_PEPPER: z.string().min(32),
  AUTH_TOKEN_PEPPER: z.string().min(32),
  TOTP_ENCRYPTION_KEY: z
    .string()
    .refine(v => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes in base64'),
  WEBAUTHN_RP_ID: z.string().min(1),
  WEBAUTHN_RP_NAME: z.string().min(1),
  PASSWORD_BREACH_CHECK: z.enum(['local', 'hibp']).default('local'),
  // module 03 (roles and permissions)
  PLATFORM_TEAM_EMAIL_DOMAIN: z.string().min(3).default('societyapp.in'),
  // module 06 (platform billing): the platform's own gateway account; required when PROVIDERS_MODE=real
  PLATFORM_GATEWAY_ACCOUNT_ID: z.string().min(1).default('platform'),
  PLATFORM_RAZORPAY_KEY_ID: z.string().min(1).default('rzp_test_fake'),
  PLATFORM_RAZORPAY_KEY_SECRET: z.string().min(16).optional(),
  PLATFORM_RAZORPAY_WEBHOOK_SECRET: z.string().min(16).default('fake-platform-webhook-secret'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform(v => v === 'true'),
});

export type Env = z.infer<typeof schema> & { appOrigins: string[] };

/** Parses a raw environment. Throws one error that lists every bad variable by name. */
export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const lines = r.error.issues.map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  const appOrigins = r.data.APP_ORIGINS.split(',')
    .map(s => s.trim())
    .filter(Boolean);
  for (const o of appOrigins) {
    try {
      new URL(o);
    } catch {
      throw new Error(`Invalid environment:\n  APP_ORIGINS: "${o}" is not a URL`);
    }
  }
  if (!r.data.COOKIE_SECURE && r.data.NODE_ENV !== 'development')
    throw new Error('Invalid environment:\n  COOKIE_SECURE: false is allowed only when NODE_ENV=development');
  if (r.data.NODE_ENV === 'production') {
    if (r.data.PROVIDERS_MODE === 'fake')
      throw new Error('Invalid environment:\n  PROVIDERS_MODE: fake is forbidden in production');
    if (!r.data.REDIS_URL) throw new Error('Invalid environment:\n  REDIS_URL: required in production');
  }
  if (r.data.PROVIDERS_MODE === 'real') {
    const unset = [
      'PLATFORM_GATEWAY_ACCOUNT_ID',
      'PLATFORM_RAZORPAY_KEY_ID',
      'PLATFORM_RAZORPAY_KEY_SECRET',
      'PLATFORM_RAZORPAY_WEBHOOK_SECRET',
    ].filter(k => !raw[k]);
    if (unset.length)
      throw new Error(
        `Invalid environment:\n${unset.map(k => `  ${k}: required when PROVIDERS_MODE=real`).join('\n')}`,
      );
  }
  return { ...r.data, appOrigins };
}

let cached: Env | undefined;
/** Typed, validated environment. */
export function env(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}
