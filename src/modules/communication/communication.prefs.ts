import { NotificationPreference } from '../../models';
import { settings } from '../society-setup/society-setup.public';
import {
  LIMITS,
  LOCKED_CATEGORIES,
  PREFERENCE_CATEGORIES,
  SETTING,
  type PreferenceCategory,
  type TemplateCategory,
} from './communication.constants';

/** Preferences (BR-16-33, BR-16-34) and quiet hours (BR-16-22). The pure functions take plain data; the DB helpers are thin. */
export interface QuietWindow {
  start: string; // HH:MM
  end: string;
}
export type Matrix = Record<string, Record<string, boolean>>;

/** A template category as the preference matrix knows it: PLATFORM and anything unlisted counts as SYSTEM. */
export function preferenceCategory(c: TemplateCategory): PreferenceCategory | 'EMERGENCY' | 'SECURITY' {
  if (c === 'EMERGENCY' || c === 'SECURITY') return c;
  return (PREFERENCE_CATEGORIES as readonly string[]).includes(c) ? (c as PreferenceCategory) : 'SYSTEM';
}
export const isLockedCategory = (c: TemplateCategory): boolean =>
  (LOCKED_CATEGORIES as readonly string[]).includes(c);

/** BR-16-21: a missing entry means on; `IN_APP` is never switched off; locked categories are always on. */
export function isChannelOn(
  matrix: Matrix | null | undefined,
  category: TemplateCategory,
  channel: 'IN_APP' | 'PUSH' | 'SMS' | 'WHATSAPP' | 'EMAIL',
): boolean {
  if (channel === 'IN_APP' || isLockedCategory(category)) return true;
  return matrix?.[preferenceCategory(category)]?.[channel] !== false;
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
/** Local clock minutes since midnight of an instant in a zone. */
export function localMinutes(at: Date, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map(x => [x.type, x.value]),
  );
  return Number(p.hour) * 60 + Number(p.minute);
}
/** PURE: is `at` inside the window (a window may wrap midnight, 22:00 to 07:00)? Start is inside, end is outside. Equal start and end means no window. */
export function inQuietHours(w: QuietWindow | null, at: Date, tz = 'Asia/Kolkata'): boolean {
  if (!w) return false;
  const s = toMinutes(w.start);
  const e = toMinutes(w.end);
  if (s === e) return false;
  const m = localMinutes(at, tz);
  return s < e ? m >= s && m < e : m >= s || m < e;
}
/** PURE: the instant the window ends (the next local `end` time, at second 0). */
export function quietEnd(w: QuietWindow, at: Date, tz = 'Asia/Kolkata'): Date {
  const delta = (toMinutes(w.end) - localMinutes(at, tz) + 1440) % 1440;
  const base = at.getTime() - at.getUTCSeconds() * 1000 - at.getUTCMilliseconds();
  return new Date(base + (delta === 0 ? 1440 : delta) * 60_000);
}

export type PrefsLike = Pick<
  NotificationPreference,
  | 'locale'
  | 'channelMatrix'
  | 'quietHoursMode'
  | 'quietHoursStart'
  | 'quietHoursEnd'
  | 'whatsappOptIn'
  | 'emailBouncedAt'
>;
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);

/** BR-16-22: the user's own window, else the society's `communication.quietHours*`, else 22:00 to 07:00; `OFF` disables it. */
export async function effectiveWindow(
  prefs: PrefsLike | null,
  societyId: number | null,
): Promise<QuietWindow | null> {
  if (prefs?.quietHoursMode === 'OFF') return null;
  if (prefs?.quietHoursMode === 'CUSTOM' && prefs.quietHoursStart && prefs.quietHoursEnd)
    return { start: hhmm(prefs.quietHoursStart)!, end: hhmm(prefs.quietHoursEnd)! };
  if (societyId) {
    const [start, end] = await Promise.all([
      settings.get(societyId, SETTING.quietHoursStart as never),
      settings.get(societyId, SETTING.quietHoursEnd as never),
    ]);
    return { start: String(start), end: String(end) };
  }
  return { start: LIMITS.defaultQuietStart, end: LIMITS.defaultQuietEnd };
}

export async function getOrCreatePreferences(userId: number): Promise<NotificationPreference> {
  const found = await NotificationPreference.findOne({ where: { userId } });
  if (found) return found;
  await NotificationPreference.bulkCreate([{ userId } as never], { ignoreDuplicates: true });
  return (await NotificationPreference.findOne({ where: { userId } }))!;
}
export async function preferencesFor(userIds: number[]): Promise<Map<number, NotificationPreference>> {
  const rows = userIds.length ? await NotificationPreference.findAll({ where: { userId: userIds } }) : [];
  return new Map(rows.map(r => [r.userId, r]));
}
