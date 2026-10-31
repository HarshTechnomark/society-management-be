import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/lib/env';

const base = {
  DATABASE_URL: 'mysql://u:p@localhost:3306/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_PEPPER: 'b'.repeat(32),
  AUTH_TOKEN_PEPPER: 'c'.repeat(32),
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_RP_NAME: 'SocietyApp',
};

describe('env', () => {
  it('missing DATABASE_URL throws and names the variable', () => {
    expect(() => parseEnv({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/);
  });
  it('parses a valid environment with defaults', () => {
    const e = parseEnv(base);
    expect(e.PORT).toBe(4000);
    expect(e.appOrigins).toEqual(['http://localhost:3000']);
    expect(e.COOKIE_SECURE).toBe(true);
    expect(e.PROVIDERS_MODE).toBe('fake');
    expect(e.REDIS_URL).toBeUndefined();
  });
  it('rejects a bad origin', () => {
    expect(() => parseEnv({ ...base, APP_ORIGINS: 'not a url' })).toThrow(/APP_ORIGINS/);
  });
  it('names every missing module 02 secret and rejects short ones', () => {
    expect(() => parseEnv({ DATABASE_URL: base.DATABASE_URL })).toThrow(
      /JWT_ACCESS_SECRET[\s\S]*TOTP_ENCRYPTION_KEY/,
    );
    expect(() => parseEnv({ ...base, AUTH_TOKEN_PEPPER: 'short' })).toThrow(/AUTH_TOKEN_PEPPER/);
    expect(() => parseEnv({ ...base, TOTP_ENCRYPTION_KEY: 'AAAA' })).toThrow(/TOTP_ENCRYPTION_KEY/);
  });
  it('allows insecure cookies only in development', () => {
    expect(() => parseEnv({ ...base, COOKIE_SECURE: 'false', NODE_ENV: 'development' })).not.toThrow();
    expect(() => parseEnv({ ...base, COOKIE_SECURE: 'false', NODE_ENV: 'staging' })).toThrow(/COOKIE_SECURE/);
  });
  it('forbids fake providers and a missing Redis in production', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', REDIS_URL: 'redis://x:6379' })).toThrow(
      /PROVIDERS_MODE/,
    );
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', PROVIDERS_MODE: 'real' })).toThrow(/REDIS_URL/);
  });
});
