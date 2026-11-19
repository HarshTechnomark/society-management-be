import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  placeholdersOf,
  renderChannels,
  renderText,
  smsSegments,
  smsWithinLimit,
  stripTags,
  unknownPlaceholders,
  validateData,
} from '../../../src/modules/communication/communication.render';
import {
  maskEmail,
  maskMobile,
  mobileKey,
  respondentKey,
  decrypt,
  encrypt,
  decryptJson,
  encryptJson,
} from '../../../src/modules/communication/communication.crypto';

describe('rendering (5.6, BR-16-29, BR-16-30, BR-16-51)', () => {
  it('formats money with Indian grouping and shows paise only when needed', () => {
    expect(formatMoney(12_500_000)).toBe('₹1,25,000');
    expect(formatMoney(110_000)).toBe('₹1,100');
    expect(formatMoney(12_550)).toBe('₹125.50');
    expect(formatMoney(5)).toBe('₹0.05');
    expect(formatMoney(100)).toBe('₹1');
    expect(formatMoney(0)).toBe('₹0');
    expect(formatMoney(1_00_00_000_00)).toBe('₹1,00,00,000');
  });
  it('formats dates in society time', () => {
    expect(formatDate('2026-11-05')).toBe('05 Nov 2026');
    expect(formatDate(new Date('2026-11-05T20:00:00Z'))).toBe('06 Nov 2026'); // 01:30 IST next day
    expect(formatDateTime(new Date('2026-11-05T20:00:00Z'))).toBe('06 Nov 2026, 01:30');
    expect(formatDate(new Date('2026-11-05T20:00:00Z'), 'UTC')).toBe('05 Nov 2026');
  });
  it('lists and checks placeholders', () => {
    expect(placeholdersOf('Hi {{ name }}, {{amount}} due, {{name}}')).toEqual(['name', 'amount']);
    expect(unknownPlaceholders('{{a}} {{b}}', { a: { type: 'string' } })).toEqual(['b']);
  });
  it('validates data: missing, wrong type, too long', () => {
    const schema = {
      name: { type: 'string' as const, required: true, maxLength: 5 },
      amt: { type: 'money' as const, required: false },
      link: { type: 'url' as const },
    };
    expect(() => validateData(schema, { name: 'Asha', link: '/x' })).not.toThrow();
    expect(() => validateData(schema, { link: '/x' })).toThrowError(/required/);
    try {
      validateData(schema, { link: '/x' });
    } catch (e) {
      expect((e as { code: string }).code).toBe('TEMPLATE_VARIABLE_MISSING');
    }
    for (const bad of [
      { name: 'toolong', link: '/x' },
      { name: 'a', amt: 1.5, link: '/x' },
      { name: 'a', link: 'javascript:x' },
      { name: 5, link: '/x' },
    ])
      try {
        validateData(schema, bad as never);
        expect.unreachable();
      } catch (e) {
        expect((e as { code: string }).code).toBe('TEMPLATE_VARIABLE_INVALID');
      }
  });
  it('renders values by type, escapes html and cuts SMS variables to 30 characters', () => {
    const schema = {
      amt: { type: 'money' as const },
      d: { type: 'date' as const },
      n: { type: 'string' as const },
    };
    expect(renderText('Pay {{amt}} by {{d}}', schema, { amt: 125_000, d: '2026-12-01' })).toBe(
      'Pay ₹1,250 by 01 Dec 2026',
    );
    expect(renderText('{{n}}', schema, { n: '<b>"x"</b>' }, { html: true })).toBe(
      '&lt;b&gt;&quot;x&quot;&lt;/b&gt;',
    );
    const long = 'x'.repeat(40);
    expect(renderText('{{n}}', schema, { n: long }, { sms: true })).toBe('x'.repeat(29) + '…');
    expect(renderText('{{n}}', schema, { n: long })).toBe(long);
    expect(renderText('{{gone}}', schema, {})).toBe('');
  });
  it('counts SMS segments (GSM-7 and Unicode)', () => {
    expect(smsSegments('Hello')).toEqual({ encoding: 'GSM-7', length: 5, segments: 1 });
    expect(smsSegments('a'.repeat(160)).segments).toBe(1);
    expect(smsSegments('a'.repeat(161)).segments).toBe(2);
    expect(smsSegments('a'.repeat(306)).segments).toBe(2);
    expect(smsSegments('a'.repeat(307)).segments).toBe(3);
    expect(smsSegments('€'.repeat(80))).toMatchObject({ encoding: 'GSM-7', length: 160, segments: 1 });
    expect(smsSegments('नमस्ते')).toMatchObject({ encoding: 'UCS-2', segments: 1 });
    expect(smsSegments('न'.repeat(134)).segments).toBe(2);
    expect(smsSegments('न'.repeat(135)).segments).toBe(3);
    expect(smsWithinLimit('a'.repeat(306))).toBe(true);
    expect(smsWithinLimit('a'.repeat(307))).toBe(false);
  });
  it('renders all channels of a template with the push body cut to 140', () => {
    const schema = { title: { type: 'string' as const }, link: { type: 'url' as const } };
    const r = renderChannels(
      {
        inAppTitle: 'N: {{title}}',
        inAppBody: 'b',
        pushTitle: 'P',
        pushBody: '{{title}}',
        smsBody: 'S {{title}} {{link}}',
        emailSubject: 'E {{title}}',
        emailText: 'x {{link}}',
        whatsappTemplateName: 'wa',
        whatsappParams: ['title'],
      },
      schema,
      { title: 'y'.repeat(300), link: 'https://a.in/1' },
      { deepLink: '/notices/{{title}}' },
    );
    expect(r.push!.body).toHaveLength(140);
    expect(r.inApp!.title.startsWith('N: yyy')).toBe(true);
    expect(r.sms).toContain('https://a.in/1');
    expect(r.email!.html).toContain('<p>');
    expect(r.whatsapp!.name).toBe('wa');
    expect(r.deepLink).toContain('/notices/');
  });
  it('strips tags', () => {
    expect(stripTags('<p>Hello <b>world</b></p><p>two &amp; three</p>')).toBe('Hello world\ntwo & three');
  });
});

describe('crypto helpers (BR-16-31, BR-16-48)', () => {
  it('encrypts and decrypts, with a fresh IV each time', () => {
    const a = encrypt('9876543210');
    const b = encrypt('9876543210');
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a)).toBe('9876543210');
    expect(decryptJson<{ x: number }>(encryptJson({ x: 1 })).x).toBe(1);
    const tampered = Buffer.from(a);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decrypt(tampered)).toThrow();
  });
  it('masks and keys recipients', () => {
    expect(maskMobile('9876543210')).toBe('98XXXXX210');
    expect(maskEmail('ravi@mail.in')).toBe('r****@mail.in');
    expect(mobileKey('9876543210')).toMatch(/^m:[0-9a-f]{32}$/);
  });
  it('respondent keys: anonymous is an HMAC (differs from the named sha256), stable and per scope', () => {
    const anon = respondentKey(5, 'PERSON', 9, true);
    expect(anon).toMatch(/^[0-9a-f]{64}$/);
    expect(anon).toBe(respondentKey(5, 'PERSON', 9, true));
    expect(anon).not.toBe(respondentKey(5, 'PERSON', 9, false));
    expect(respondentKey(5, 'FLAT', 9, true)).not.toBe(anon);
  });
});
