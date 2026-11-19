import { now } from '../../lib/clock';
import { members, usersWithPermission } from '../access-control/access-control.public';
import { platformUsersWith } from '../platform-ops/platform-ops.notify';
import { residents } from '../residents/residents.public';
import { ERR, LIMITS } from './communication.constants';
import { resolveAudience } from './communication.audience';
import { NotifyError } from './communication.render';
import type { Recipient } from './communication.types';

/** Recipient union of 8.38: validation, "does it need the fan-out job" and resolution to user ids and external contacts (6.5 steps 4 and 5). */
export const MOBILE_RE = /^[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Target {
  userId: number | null;
  mobile: string | null;
  email: string | null;
  /** The caller supplied the contact itself (legacy `{ userId, mobile }`): used as is, no verification needed. */
  explicit: boolean;
}

export const isQueryRecipient = (r: Recipient): boolean =>
  typeof r === 'object' &&
  ('unitId' in r || 'roleKey' in r || 'permission' in r || 'audience' in r || 'platformPermission' in r);

/** 6.5 step 4: any audience, role, permission or unit recipient, or more than 200 explicit recipients, goes to the fan-out job. */
export const needsFanout = (recipients: Recipient[]): boolean =>
  recipients.some(isQueryRecipient) || recipients.length > LIMITS.inlineRecipientsMax;

/** `NOTIFY_RECIPIENTS_INVALID`: empty list, more than 10,000, malformed mobile or e-mail, unknown shape. Legacy callers are lenient (`strict = false`). */
export function validateRecipients(recipients: Recipient[], strict: boolean): void {
  if (!Array.isArray(recipients) || (strict && recipients.length === 0))
    throw new NotifyError(ERR.notifyRecipientsInvalid, 'Recipients must be a non-empty list');
  if (recipients.length > LIMITS.explicitRecipientsMax)
    throw new NotifyError(ERR.notifyRecipientsInvalid, 'Too many explicit recipients (use an audience)');
  if (!strict) return;
  for (const r of recipients) {
    if (typeof r === 'number') {
      if (!Number.isInteger(r) || r < 1)
        throw new NotifyError(ERR.notifyRecipientsInvalid, 'Invalid user id');
    } else if (!r || typeof r !== 'object')
      throw new NotifyError(ERR.notifyRecipientsInvalid, 'Invalid recipient');
    else if ('mobile' in r && !('userId' in r) && !MOBILE_RE.test(String(r.mobile)))
      throw new NotifyError(ERR.notifyRecipientsInvalid, 'Mobile must be 10 digits starting 6 to 9');
    else if ('email' in r && !('userId' in r) && r.email != null && !EMAIL_RE.test(String(r.email)))
      throw new NotifyError(ERR.notifyRecipientsInvalid, 'Invalid e-mail address');
  }
}

const ymdIn = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now());

/**
 * Resolves every recipient to a unique list of targets. Query recipients need `societyId` (platform permission excepted).
 * Users are listed once even when several recipients name them; mobile-only residents of an audience become external targets.
 */
export async function resolveTargets(
  recipients: Recipient[],
  societyId: number | undefined,
  tz = 'Asia/Kolkata',
): Promise<Target[]> {
  const byUser = new Map<number, Target>();
  const external = new Map<string, Target>();
  const addUser = (id: number | null | undefined, extra: Partial<Target> = {}) => {
    if (!id) return;
    const cur = byUser.get(id);
    byUser.set(id, { userId: id, mobile: null, email: null, explicit: false, ...cur, ...extra });
  };
  const needSociety = () => {
    if (!societyId) throw new NotifyError(ERR.notifySocietyRequired, 'This recipient needs opts.societyId');
    return societyId;
  };
  for (const r of recipients) {
    if (typeof r === 'number') addUser(r);
    else if ('userId' in r)
      addUser(
        r.userId,
        r.mobile || r.email ? { mobile: r.mobile ?? null, email: r.email ?? null, explicit: true } : {},
      );
    else if ('mobile' in r)
      external.set(`m:${r.mobile}`, {
        userId: null,
        mobile: r.mobile,
        email: r.email ?? null,
        explicit: true,
      });
    else if ('email' in r)
      external.set(`e:${r.email.toLowerCase()}`, {
        userId: null,
        mobile: null,
        email: r.email,
        explicit: true,
      });
    else if ('roleKey' in r)
      for (const m of await members.listForSociety(needSociety(), {
        roleKeys: [r.roleKey],
        statuses: ['ACTIVE'],
      }))
        addUser(m.userId);
    else if ('permission' in r)
      for (const id of await usersWithPermission(needSociety(), r.permission)) addUser(id);
    else if ('platformPermission' in r)
      for (const id of await platformUsersWith(r.platformPermission)) addUser(id);
    else if ('unitId' in r) {
      const sid = needSociety();
      if (r.relation === 'BILL_TO') {
        const b = await residents.billToFor(r.unitId, ymdIn(tz));
        if (b?.userId) addUser(b.userId);
        else if (b?.mobile)
          external.set(`m:${b.mobile}`, { userId: null, mobile: b.mobile, email: null, explicit: true });
      } else {
        const rel = r.relation ?? 'ANY';
        for (const l of await residents.listForUnit(sid, r.unitId)) {
          if (rel === 'OWNERS' && l.tenancyId !== null) continue;
          if (rel === 'TENANTS' && l.tenancyId === null) continue;
          if (l.userId) addUser(l.userId);
          else if (l.mobile)
            external.set(`m:${l.mobile}`, { userId: null, mobile: l.mobile, email: null, explicit: true });
        }
      }
    } else if ('audience' in r) {
      const a = await resolveAudience(needSociety(), {
        type: r.audience.type,
        relation: r.audience.relation,
        ids: r.audience.ids,
      });
      for (const p of a.people) {
        if (p.userId) addUser(p.userId);
        else if (p.mobile)
          external.set(`m:${p.mobile}`, { userId: null, mobile: p.mobile, email: null, explicit: true });
      }
    } else throw new NotifyError(ERR.notifyRecipientsInvalid, 'Unknown recipient shape');
  }
  return [...byUser.values(), ...external.values()];
}
