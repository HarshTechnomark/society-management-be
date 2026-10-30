import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/lib/env';

describe('env', () => {
  it('missing DATABASE_URL throws and names the variable', () => {
    expect(() => parseEnv({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/);
  });
  it('parses a valid environment with defaults', () => {
    const e = parseEnv({ DATABASE_URL: 'mysql://u:p@localhost:3306/db' });
    expect(e.PORT).toBe(4000);
    expect(e.appOrigins).toEqual(['http://localhost:3000']);
  });
  it('rejects a bad origin', () => {
    expect(() => parseEnv({ DATABASE_URL: 'mysql://u:p@localhost/db', APP_ORIGINS: 'not a url' })).toThrow(
      /APP_ORIGINS/,
    );
  });
});
