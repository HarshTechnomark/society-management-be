import { NotificationPreference, SocietyMember, User, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { ConflictError, UnprocessableError, ValidationError } from '../../utils/errors';
import { entitlements } from '../subscriptions/subscriptions.public';
import {
  AUDIT,
  ENT,
  ENTITY,
  ERR,
  LIMITS,
  LOCALES,
  LOCKED_CATEGORIES,
  PREFERENCE_CATEGORIES,
  PREFERENCE_CHANNELS,
} from './communication.constants';
import { maskEmail } from './communication.crypto';
import { getOrCreatePreferences } from './communication.prefs';

/** 8.23: own notification preferences (BR-16-33, BR-16-34). User level: no society context. */
type ChannelFlags = Record<(typeof PREFERENCE_CATEGORIES)[number] | string, boolean>;
export interface CategoryView {
  key: string;
  locked: boolean;
  channels: Record<'PUSH' | 'SMS' | 'WHATSAPP' | 'EMAIL', boolean>;
}
const hhmm = (t: string | null): string | null => (t ? t.slice(0, 5) : null);

/** Whether any ACTIVE society of the user has WhatsApp messaging in its plan (`whatsapp.available`). */
async function whatsappAvailable(userId: number): Promise<boolean> {
  const rows = await SocietyMember.findAll({
    where: { userId, status: 'ACTIVE' },
    attributes: ['societyId'],
  });
  for (const id of [...new Set(rows.map(r => r.societyId))])
    if (await entitlements.isFeatureOn(id, ENT.whatsappMessaging as never).catch(() => false)) return true;
  return false;
}

export async function getPreferences(ctx: Ctx) {
  const userId = ctx.user!.id;
  const p = await getOrCreatePreferences(userId);
  const user = await User.findByPk(userId, { attributes: ['id', 'locale', 'email'] });
  const matrix = p.channelMatrix ?? {};
  const flags = (key: string, locked: boolean): CategoryView['channels'] =>
    Object.fromEntries(
      PREFERENCE_CHANNELS.map(ch => [ch, locked ? true : matrix[key]?.[ch] !== false]),
    ) as CategoryView['channels'];
  const categories: CategoryView[] = [
    ...PREFERENCE_CATEGORIES.map(key => ({ key, locked: false, channels: flags(key, false) })),
    ...LOCKED_CATEGORIES.map(key => ({ key, locked: true, channels: flags(key, true) })),
  ];
  return {
    locale: p.locale,
    effectiveLocale: p.locale ?? user?.locale ?? 'en-IN',
    categories,
    quietHours: {
      mode: p.quietHoursMode,
      start: hhmm(p.quietHoursStart) ?? LIMITS.defaultQuietStart,
      end: hhmm(p.quietHoursEnd) ?? LIMITS.defaultQuietEnd,
    },
    whatsapp: {
      optIn: p.whatsappOptIn,
      optInAt: p.whatsappOptInAt ? p.whatsappOptInAt.toISOString() : null,
      available: await whatsappAvailable(userId),
    },
    email: { address: user?.email ? maskEmail(user.email) : null, bounced: p.emailBouncedAt !== null },
    version: p.version,
  };
}

export interface PreferencesInput {
  version: number;
  locale: string | null;
  categories: Record<string, Record<'PUSH' | 'SMS' | 'WHATSAPP' | 'EMAIL', boolean>>;
  quietHours: { mode: 'SOCIETY_DEFAULT' | 'CUSTOM' | 'OFF'; start?: string; end?: string };
  whatsappOptIn: boolean;
}

export async function putPreferences(ctx: Ctx, input: PreferencesInput) {
  const userId = ctx.user!.id;
  // a locked row sent back as shown (every channel on) is ignored; only an actual change is refused
  const isLocked = (k: string) => (LOCKED_CATEGORIES as readonly string[]).includes(k);
  const locked = Object.keys(input.categories).filter(
    k => isLocked(k) && Object.values(input.categories[k] ?? {}).some(v => v === false),
  );
  if (locked.length)
    throw new UnprocessableError(
      ERR.preferenceLocked,
      'Emergency and security messages cannot be switched off',
      locked.map(k => ({ field: `categories.${k}`, message: 'Always on' })),
    );
  input = {
    ...input,
    categories: Object.fromEntries(Object.entries(input.categories).filter(([k]) => !isLocked(k))),
  };
  const unknown = Object.keys(input.categories).filter(
    k => !(PREFERENCE_CATEGORIES as readonly string[]).includes(k),
  );
  if (unknown.length)
    throw new ValidationError(unknown.map(k => ({ field: `categories.${k}`, message: 'Unknown category' })));
  if (input.locale !== null && !(LOCALES as readonly string[]).includes(input.locale))
    throw new ValidationError([{ field: 'locale', message: 'Unknown language' }]);
  const q = input.quietHours;
  if (q.mode === 'CUSTOM') {
    if (!q.start || !q.end)
      throw new UnprocessableError(ERR.quietHoursInvalid, 'Choose a start and an end time', [
        { field: 'quietHours', message: 'Start and end are required' },
      ]);
    if (q.start === q.end)
      throw new UnprocessableError(ERR.quietHoursInvalid, 'Start and end must differ', [
        { field: 'quietHours.end', message: 'Must differ from start' },
      ]);
  }
  await getOrCreatePreferences(userId);
  const result = await sequelize.transaction(async t => {
    const p = (await NotificationPreference.findOne({
      where: { userId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    }))!;
    if (p.version !== input.version)
      throw new ConflictError(ERR.staleVersion, 'Your preferences changed elsewhere. Reload and try again.');
    const before = {
      locale: p.locale,
      quietHoursMode: p.quietHoursMode,
      whatsappOptIn: p.whatsappOptIn,
      matrix: p.channelMatrix,
    };
    const at = now();
    const matrix: Record<string, Record<string, boolean>> = {};
    for (const [k, v] of Object.entries(input.categories as Record<string, ChannelFlags>))
      matrix[k] = Object.fromEntries(PREFERENCE_CHANNELS.map(ch => [ch, v[ch] !== false]));
    const wasOptIn = p.whatsappOptIn;
    p.locale = input.locale;
    p.channelMatrix = matrix;
    p.quietHoursMode = q.mode;
    p.quietHoursStart = q.mode === 'CUSTOM' ? q.start! : null;
    p.quietHoursEnd = q.mode === 'CUSTOM' ? q.end! : null;
    if (!wasOptIn && input.whatsappOptIn) {
      p.whatsappOptIn = true;
      p.whatsappOptInAt = at;
      p.whatsappOptInSource = 'APP';
    } else if (wasOptIn && !input.whatsappOptIn) {
      p.whatsappOptIn = false;
      p.whatsappOptOutAt = at;
    }
    p.version += 1;
    await p.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.preferencesUpdated,
        entityType: ENTITY.preferences,
        entityId: p.id,
        societyId: null,
        before,
        after: {
          locale: p.locale,
          quietHoursMode: p.quietHoursMode,
          whatsappOptIn: p.whatsappOptIn,
          matrix: p.channelMatrix,
        },
      },
      t,
    );
    if (wasOptIn && !input.whatsappOptIn)
      await audit(
        ctx,
        { action: AUDIT.whatsappOptedOut, entityType: ENTITY.preferences, entityId: p.id, societyId: null },
        t,
      );
    return p;
  });
  void result;
  return getPreferences(ctx);
}
