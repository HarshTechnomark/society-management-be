import pino, { type Logger } from 'pino';

/** Keys whose values are never written to logs (BR-01-3). */
export const REDACT_KEY = /password|otp|token|secret|cookie|authorization|aadhaar|pan/i;

export const maskPhone = (s: string): string => {
  const d = s.replace(/\D/g, '');
  if (d.length < 10) return s;
  const ten = d.slice(-10);
  return `${ten.slice(0, 2)}XXXXX${ten.slice(-3)}`;
};

export const maskEmail = (s: string): string => {
  const [user, domain] = s.split('@');
  if (!domain) return s;
  return `${user.slice(0, 1)}****@${domain}`;
};

const PHONE_RE = /^(\+?91)?[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Deep copy with secrets replaced by `[REDACTED]`, phones and emails masked. Used by logs and audit rows. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (PHONE_RE.test(value.replace(/[\s-]/g, ''))) return maskPhone(value) as T;
    if (EMAIL_RE.test(value)) return maskEmail(value) as T;
    return value;
  }
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1)) as T;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info');

export const logger: Logger = pino({
  level,
  base: { service: 'society-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { log: obj => redact(obj as Record<string, unknown>) },
  serializers: { err: pino.stdSerializers.err },
});

/** Logger bound to a request so every line carries the request id (BR-01-2). */
export const childLogger = (bindings: { requestId?: string; userId?: number; societyId?: number }): Logger =>
  logger.child(bindings);
