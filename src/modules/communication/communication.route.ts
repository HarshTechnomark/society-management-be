import type {
  Channel,
  DeliveryClass,
  ExternalChannel,
  SkipReason,
  TemplateCategory,
} from './communication.constants';
import { RETRY } from './communication.constants';
import { isLockedCategory } from './communication.prefs';

/**
 * PURE channel routing of BR-16-21 and BR-16-22 for ONE recipient: which delivery rows are created, with which status, and which fallback rows
 * replace a WhatsApp row that cannot be sent. No database; `communication.core.ts` gathers the facts and writes the rows.
 */
export interface RouteFacts {
  deliveryClass: DeliveryClass;
  category: TemplateCategory;
  /** Channels to send (template defaults or `opts.channels`), IN_APP not included. */
  requested: ExternalChannel[];
  /** The template's `allowedChannels` (fallbacks must be allowed). */
  allowed: Channel[];
  hasUser: boolean;
  hasMobile: boolean;
  hasEmail: boolean;
  pushSubscriptions: number;
  /** Preference matrix lookup for an optional channel. */
  prefOn(channel: ExternalChannel): boolean;
  smsTemplateOk: boolean;
  whatsappTemplateOk: boolean;
  whatsappOptIn: boolean;
  whatsappFeatureOn: boolean;
  inQuietHours: boolean;
  urgent: boolean;
  /** Legacy stand-in templates ignore quiet hours. */
  legacy: boolean;
}
export interface RouteRow {
  channel: ExternalChannel;
  status: 'QUEUED' | 'DEFERRED' | 'SKIPPED';
  skipReason?: SkipReason;
  /** The WhatsApp row this one replaces (BR-16-21). */
  fallbackOf?: ExternalChannel;
}

const IGNORES_PREFERENCES = new Set<DeliveryClass>(['OTP', 'SAFETY', 'SECURITY']);

function skipReasonFor(ch: ExternalChannel, f: RouteFacts): SkipReason | null {
  if (!IGNORES_PREFERENCES.has(f.deliveryClass) && !isLockedCategory(f.category) && !f.prefOn(ch))
    return 'PREFERENCE_OFF';
  switch (ch) {
    case 'PUSH':
      return f.hasUser && f.pushSubscriptions > 0 ? null : 'NO_SUBSCRIPTION';
    case 'SMS':
      return !f.hasMobile ? 'NO_CONTACT' : !f.smsTemplateOk ? 'NO_TEMPLATE' : null;
    case 'WHATSAPP':
      if (!f.hasMobile) return 'NO_CONTACT';
      if (!f.whatsappTemplateOk) return 'NO_TEMPLATE';
      if (f.deliveryClass !== 'OTP' && !f.whatsappOptIn) return 'NOT_OPTED_IN';
      if (!f.whatsappFeatureOn) return 'FEATURE_OFF';
      return null;
    case 'EMAIL':
      return f.hasEmail ? null : 'NO_CONTACT';
  }
}

/** BR-16-22: STANDARD and TRANSACTIONAL push, SMS and WhatsApp inside quiet hours are DEFERRED, unless `urgent`. IN_APP and EMAIL never. */
export const isDeferred = (ch: ExternalChannel, f: RouteFacts): boolean =>
  !f.legacy &&
  !f.urgent &&
  f.inQuietHours &&
  (f.deliveryClass === 'STANDARD' || f.deliveryClass === 'TRANSACTIONAL') &&
  (ch === 'PUSH' || ch === 'SMS' || ch === 'WHATSAPP');

export function routeChannels(f: RouteFacts): RouteRow[] {
  const rows: RouteRow[] = [];
  const set = new Set<ExternalChannel>(f.requested);
  const place = (ch: ExternalChannel, fallbackOf?: ExternalChannel): RouteRow => {
    const reason = skipReasonFor(ch, f);
    const row: RouteRow = reason
      ? { channel: ch, status: 'SKIPPED', skipReason: reason }
      : { channel: ch, status: isDeferred(ch, f) ? 'DEFERRED' : 'QUEUED' };
    if (fallbackOf) row.fallbackOf = fallbackOf;
    rows.push(row);
    return row;
  };
  for (const ch of f.requested) {
    const row = place(ch);
    const fallbackable: SkipReason[] = ['NO_TEMPLATE', 'NOT_OPTED_IN', 'FEATURE_OFF'];
    if (ch === 'WHATSAPP' && row.status === 'SKIPPED' && fallbackable.includes(row.skipReason!)) {
      const next = fallbackChannel(set, f.allowed);
      if (next) {
        set.add(next);
        place(next, 'WHATSAPP');
      }
    }
  }
  return rows;
}

/** BR-16-21 / BR-16-24: WhatsApp falls back to SMS (allowed and not already in the set), otherwise to push. */
export function fallbackChannel(
  inSet: ReadonlySet<ExternalChannel>,
  allowed: readonly Channel[],
): ExternalChannel | null {
  if (allowed.includes('SMS') && !inSet.has('SMS')) return 'SMS';
  if (allowed.includes('PUSH') && !inSet.has('PUSH')) return 'PUSH';
  return null;
}

/** BR-16-27: after the last failure a WhatsApp row of SAFETY, SECURITY or TRANSACTIONAL creates an SMS row, a failed SMS row a PUSH row. */
export function failureFallback(
  deliveryClass: DeliveryClass,
  failed: ExternalChannel,
  inSet: ReadonlySet<ExternalChannel>,
  allowed: readonly Channel[],
): ExternalChannel | null {
  if (!['SAFETY', 'SECURITY', 'TRANSACTIONAL'].includes(deliveryClass)) return null;
  if (failed === 'WHATSAPP' && allowed.includes('SMS') && !inSet.has('SMS')) return 'SMS';
  if (failed === 'SMS' && allowed.includes('PUSH') && !inSet.has('PUSH')) return 'PUSH';
  return null;
}

/** 5 attempts for STANDARD, TRANSACTIONAL and SECURITY, 3 for SAFETY, 2 for OTP (BR-16-19, BR-16-27). */
export function retryPolicy(cls: DeliveryClass): { maxAttempts: number; delaysSec: readonly number[] } {
  return cls === 'OTP' ? RETRY.OTP : cls === 'SAFETY' ? RETRY.SAFETY : RETRY.OTHER;
}

/** BR-16-20: SUSPENDED sends only OTP, SAFETY, SECURITY and TRANSACTIONAL; CLOSED only OTP and `sendWhenClosed` templates. */
export function suppressedBySociety(status: string, cls: DeliveryClass, sendWhenClosed: boolean): boolean {
  if (status === 'CLOSED') return !(cls === 'OTP' || sendWhenClosed);
  if (status === 'SUSPENDED') return !['OTP', 'SAFETY', 'SECURITY', 'TRANSACTIONAL'].includes(cls);
  return false;
}
