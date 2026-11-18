import { describe, expect, it } from 'vitest';
import {
  failureFallback,
  fallbackChannel,
  retryPolicy,
  routeChannels,
  suppressedBySociety,
  type RouteFacts,
} from '../../../src/modules/communication/communication.route';
import { inQuietHours, isChannelOn, quietEnd } from '../../../src/modules/communication/communication.prefs';

const base = (o: Partial<RouteFacts> = {}): RouteFacts => ({
  deliveryClass: 'STANDARD',
  category: 'NOTICES',
  requested: ['PUSH'],
  allowed: ['IN_APP', 'PUSH', 'SMS', 'WHATSAPP', 'EMAIL'],
  hasUser: true,
  hasMobile: true,
  hasEmail: true,
  pushSubscriptions: 1,
  prefOn: () => true,
  smsTemplateOk: true,
  whatsappTemplateOk: true,
  whatsappOptIn: true,
  whatsappFeatureOn: true,
  inQuietHours: false,
  urgent: false,
  legacy: false,
  ...o,
});

describe('channel routing (BR-16-21, BR-16-22)', () => {
  it('queues a normal channel', () => {
    expect(routeChannels(base())).toEqual([{ channel: 'PUSH', status: 'QUEUED' }]);
  });
  it('skips with the documented reasons', () => {
    expect(routeChannels(base({ prefOn: () => false }))[0]).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'PREFERENCE_OFF',
    });
    expect(routeChannels(base({ pushSubscriptions: 0 }))[0]).toMatchObject({ skipReason: 'NO_SUBSCRIPTION' });
    expect(routeChannels(base({ requested: ['SMS'], hasMobile: false }))[0]).toMatchObject({
      skipReason: 'NO_CONTACT',
    });
    expect(routeChannels(base({ requested: ['SMS'], smsTemplateOk: false }))[0]).toMatchObject({
      skipReason: 'NO_TEMPLATE',
    });
    expect(routeChannels(base({ requested: ['EMAIL'], hasEmail: false }))[0]).toMatchObject({
      skipReason: 'NO_CONTACT',
    });
  });
  it('preferences do not apply to OTP, SAFETY, SECURITY and locked categories', () => {
    for (const deliveryClass of ['OTP', 'SAFETY', 'SECURITY'] as const)
      expect(routeChannels(base({ deliveryClass, prefOn: () => false }))[0]!.status).toBe('QUEUED');
    expect(routeChannels(base({ category: 'EMERGENCY', prefOn: () => false }))[0]!.status).toBe('QUEUED');
    expect(isChannelOn({ NOTICES: { PUSH: false } }, 'NOTICES', 'PUSH')).toBe(false);
    expect(isChannelOn({ NOTICES: { PUSH: false } }, 'NOTICES', 'IN_APP')).toBe(true);
    expect(isChannelOn({ SECURITY: { PUSH: false } }, 'SECURITY', 'PUSH')).toBe(true);
    expect(isChannelOn({}, 'PLATFORM', 'SMS')).toBe(true);
    expect(isChannelOn({ SYSTEM: { SMS: false } }, 'PLATFORM', 'SMS')).toBe(false);
  });
  it('WhatsApp checks fall back to SMS, then to push', () => {
    const wa = (o: Partial<RouteFacts>) => routeChannels(base({ requested: ['WHATSAPP'], ...o }));
    expect(wa({})).toEqual([{ channel: 'WHATSAPP', status: 'QUEUED' }]);
    expect(wa({ whatsappOptIn: false })).toEqual([
      { channel: 'WHATSAPP', status: 'SKIPPED', skipReason: 'NOT_OPTED_IN' },
      { channel: 'SMS', status: 'QUEUED', fallbackOf: 'WHATSAPP' },
    ]);
    expect(wa({ whatsappFeatureOn: false, allowed: ['IN_APP', 'PUSH', 'WHATSAPP'] })).toEqual([
      { channel: 'WHATSAPP', status: 'SKIPPED', skipReason: 'FEATURE_OFF' },
      { channel: 'PUSH', status: 'QUEUED', fallbackOf: 'WHATSAPP' },
    ]);
    const both = wa({ whatsappTemplateOk: false, requested: ['WHATSAPP', 'SMS'] });
    expect(both.map(r => r.channel)).toEqual(['WHATSAPP', 'PUSH', 'SMS']); // SMS already in the set: the fallback goes to push
    expect(both[1]).toMatchObject({ fallbackOf: 'WHATSAPP', status: 'QUEUED' });
    expect(wa({ whatsappOptIn: false, deliveryClass: 'OTP' })[0]!.status).toBe('QUEUED'); // OTP: the user chose WhatsApp
    expect(wa({ whatsappOptIn: false, hasMobile: true, smsTemplateOk: false })[1]).toMatchObject({
      channel: 'SMS',
      skipReason: 'NO_TEMPLATE',
    });
  });
  it('quiet hours defer STANDARD and TRANSACTIONAL push, SMS and WhatsApp, never e-mail, safety or urgent', () => {
    const q = (o: Partial<RouteFacts>) => routeChannels(base({ inQuietHours: true, ...o }));
    expect(q({})[0]!.status).toBe('DEFERRED');
    expect(q({ deliveryClass: 'TRANSACTIONAL', requested: ['SMS'] })[0]!.status).toBe('DEFERRED');
    expect(q({ requested: ['EMAIL'] })[0]!.status).toBe('QUEUED');
    expect(q({ deliveryClass: 'SAFETY' })[0]!.status).toBe('QUEUED');
    expect(q({ deliveryClass: 'SECURITY' })[0]!.status).toBe('QUEUED');
    expect(q({ urgent: true })[0]!.status).toBe('QUEUED');
    expect(q({ legacy: true })[0]!.status).toBe('QUEUED');
  });
  it('fallback helpers', () => {
    expect(fallbackChannel(new Set(['WHATSAPP']), ['SMS', 'PUSH'])).toBe('SMS');
    expect(fallbackChannel(new Set(['WHATSAPP', 'SMS']), ['SMS', 'PUSH'])).toBe('PUSH');
    expect(fallbackChannel(new Set(['WHATSAPP', 'SMS', 'PUSH']), ['SMS', 'PUSH'])).toBeNull();
    expect(failureFallback('SAFETY', 'WHATSAPP', new Set(['WHATSAPP']), ['SMS'])).toBe('SMS');
    expect(failureFallback('TRANSACTIONAL', 'SMS', new Set(['SMS']), ['PUSH'])).toBe('PUSH');
    expect(failureFallback('STANDARD', 'SMS', new Set(['SMS']), ['PUSH'])).toBeNull();
    expect(failureFallback('SECURITY', 'EMAIL', new Set(['EMAIL']), ['PUSH', 'SMS'])).toBeNull();
  });
  it('retry policy and society state (BR-16-19, BR-16-20, BR-16-27)', () => {
    expect(retryPolicy('OTP')).toEqual({ maxAttempts: 2, delaysSec: [5, 15] });
    expect(retryPolicy('SAFETY').delaysSec).toEqual([10, 20, 40]);
    expect(retryPolicy('STANDARD').delaysSec).toEqual([30, 120, 600, 1800, 7200]);
    expect(suppressedBySociety('ACTIVE', 'STANDARD', false)).toBe(false);
    expect(suppressedBySociety('SUSPENDED', 'STANDARD', false)).toBe(true);
    for (const c of ['OTP', 'SAFETY', 'SECURITY', 'TRANSACTIONAL'] as const)
      expect(suppressedBySociety('SUSPENDED', c, false)).toBe(false);
    expect(suppressedBySociety('CLOSED', 'TRANSACTIONAL', false)).toBe(true);
    expect(suppressedBySociety('CLOSED', 'TRANSACTIONAL', true)).toBe(false);
    expect(suppressedBySociety('CLOSED', 'OTP', false)).toBe(false);
    expect(suppressedBySociety('CLOSED', 'SAFETY', false)).toBe(true);
  });
});

describe('quiet hours maths (BR-16-22)', () => {
  const w = { start: '22:00', end: '07:00' };
  const ist = (hhmm: string) => new Date(`2026-11-01T${hhmm}:00+05:30`);
  it('wraps midnight; start is inside, end is outside', () => {
    expect(inQuietHours(w, ist('21:59'))).toBe(false);
    expect(inQuietHours(w, ist('22:00'))).toBe(true);
    expect(inQuietHours(w, ist('23:30'))).toBe(true);
    expect(inQuietHours(w, ist('03:00'))).toBe(true);
    expect(inQuietHours(w, ist('06:59'))).toBe(true);
    expect(inQuietHours(w, ist('07:00'))).toBe(false);
    expect(inQuietHours({ start: '13:00', end: '14:00' }, ist('13:30'))).toBe(true);
    expect(inQuietHours({ start: '13:00', end: '14:00' }, ist('14:30'))).toBe(false);
    expect(inQuietHours({ start: '08:00', end: '08:00' }, ist('08:00'))).toBe(false);
    expect(inQuietHours(null, ist('23:00'))).toBe(false);
  });
  it('finds the end of the window', () => {
    expect(quietEnd(w, ist('23:15')).toISOString()).toBe(new Date('2026-11-02T07:00:00+05:30').toISOString());
    expect(quietEnd(w, ist('03:10')).toISOString()).toBe(new Date('2026-11-01T07:00:00+05:30').toISOString());
  });
  it('uses the society time zone', () => {
    const at = new Date('2026-11-01T17:00:00Z'); // 17:00 UTC, 22:30 IST
    expect(inQuietHours(w, at, 'UTC')).toBe(false);
    expect(inQuietHours(w, at, 'Asia/Kolkata')).toBe(true);
  });
});
