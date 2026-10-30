import { describe, expect, it } from 'vitest';
import { redact } from '../src/lib/logger';

describe('logger redaction', () => {
  it('redacts secrets and masks phones and emails', () => {
    expect(
      redact({ password: 'x', otp: '123456', mobile: '9820011111', email: 'raj@mail.in', name: 'Raj' }),
    ).toEqual({
      password: '[REDACTED]',
      otp: '[REDACTED]',
      mobile: '98XXXXX111',
      email: 'r****@mail.in',
      name: 'Raj',
    });
  });
});
