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
  return { ...r.data, appOrigins };
}

let cached: Env | undefined;
/** Typed, validated environment. */
export function env(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}
