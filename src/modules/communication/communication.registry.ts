import { env } from '../../lib/env';
import { getLegacyTemplate, legacyTemplateKeys, type Template } from '../../lib/notify';
import { NotificationTemplate } from '../../models';
import {
  ERR,
  type Channel,
  type DeliveryClass,
  type TemplateCategory,
  type TemplateScope,
} from './communication.constants';
import { NotifyError, placeholdersOf } from './communication.render';
import { FUTURE_TEMPLATES } from './communication.registry.future';
import { COMMUNICATION_TEMPLATES } from './communication.templates.defs';
import type { ChannelTexts, TemplateDefinition, VariablesSchema } from './communication.types';

/**
 * The registry of every module's templates (section 10.2, BR-16-50): in-code `TemplateDefinition`s of the new style, the LEGACY stand-in templates
 * of modules 01 to 15 (kept with their `render()`), and the keys of modules 17 to 30 that are not built yet. `syncTemplates()` (the `templates:sync`
 * seeder) upserts all of them into `notification_templates`; code owns metadata, the platform editor owns text (`textEditedAt`).
 */
export const TEMPLATE_KEY_RE = /^[a-z_]+\.[a-z0-9_.]+$/;
export const FAKE_DLT_ID = '100000000000000';

/** Module number of a key prefix (section 10.2). */
const MODULE_OF_PREFIX: Record<string, string> = {
  auth: '02',
  access: '03',
  subscription: '04',
  societies: '05',
  support_access: '05',
  data_export: '05',
  platform_billing: '06',
  platform: '07',
  setup: '08',
  residents: '09',
  committee: '10',
  billing: '11',
  payments: '12',
  collections: '12',
  accounts: '13',
  approvals: '14',
  helpdesk: '15',
  communication: '16',
  gate: '17',
  amenities: '18',
  parking: '19',
  staff: '20',
  vendors: '21',
  reports: '24',
  resident: '25',
};
export const moduleOfKey = (key: string): string => MODULE_OF_PREFIX[key.split('.')[0]!] ?? '99';

const PLATFORM_KEYS = new Set([
  'access.platform_invitation',
  'societies.new_signup',
  'support_access.approved',
  'support_access.denied',
  'support_access.consent_expired',
  'platform_billing.approval_pending',
  'platform_billing.payment_mismatch',
]);
const SECURITY_KEYS = new Set([
  'setup.security_policy.changed',
  'accounts.bank_account_changed',
  'support_access.emergency_started',
]);
const CLOSED_OK = (k: string) =>
  ['societies.closed', 'societies.closed_resident', 'societies.purge_warning'].includes(k) ||
  k.startsWith('data_export.') ||
  k.startsWith('platform_billing.');
const NO_LIMIT_MODULES = new Set(['02', '04', '05', '06', '07', '24', '25']);

export interface TemplateMeta {
  key: string;
  module: string;
  scope: TemplateScope;
  category: TemplateCategory;
  deliveryClass: DeliveryClass;
  defaultChannels: Channel[];
  allowedChannels: Channel[];
  variables: VariablesSchema;
  sample: Record<string, unknown>;
  countsTowardLimit: boolean;
  allowEndedMembers: boolean;
  sendWhenClosed: boolean;
  deepLink: string | null;
  /** Legacy stand-in template: rendered with its own `render()`; lenient routing (no society, no quiet hours). */
  legacy: Template | null;
  /** Texts per locale of a code definition. */
  text: Record<string, ChannelTexts>;
}

const withAllowed = (cls: DeliveryClass, def: Channel[]): Channel[] => {
  const a = new Set<Channel>([...def, 'IN_APP']);
  if (cls === 'SAFETY' || cls === 'TRANSACTIONAL') a.add('SMS');
  return [...a];
};

/** Metadata of a legacy stand-in template, derived from its key prefix and the `critical` flag (BR-16-19, 10.2). */
export function legacyMeta(key: string, tpl: Template): TemplateMeta {
  const module = moduleOfKey(key);
  const prefix = key.split('.')[0]!;
  let deliveryClass: DeliveryClass = 'STANDARD';
  if (key === 'auth.otp') deliveryClass = 'OTP';
  else if (prefix === 'auth' || SECURITY_KEYS.has(key)) deliveryClass = 'SECURITY';
  else if (tpl.critical || ['04', '05', '06', '07'].includes(module)) deliveryClass = 'TRANSACTIONAL';
  const scope: TemplateScope =
    prefix === 'auth' ? 'USER' : PLATFORM_KEYS.has(key) || prefix === 'platform' ? 'PLATFORM' : 'SOCIETY';
  const category: TemplateCategory =
    deliveryClass === 'SECURITY'
      ? prefix === 'auth'
        ? 'ACCOUNT'
        : 'SECURITY'
      : ((
          {
            subscription: 'BILLING',
            platform_billing: 'BILLING',
            platform: 'PLATFORM',
            residents: 'COMMUNITY',
            committee: 'GOVERNANCE',
            billing: 'BILLING',
            payments: 'PAYMENTS',
            collections: 'PAYMENTS',
            accounts: 'BILLING',
            approvals: 'APPROVALS',
            helpdesk: 'HELPDESK',
          } as Record<string, TemplateCategory>
        )[prefix] ?? 'SYSTEM');
  const defaultChannels = (key === 'auth.otp' ? ['SMS'] : tpl.channels) as Channel[];
  const allowed =
    key === 'auth.otp' ? (['SMS', 'WHATSAPP'] as Channel[]) : withAllowed(deliveryClass, defaultChannels);
  return {
    key,
    module,
    scope,
    category,
    deliveryClass,
    defaultChannels,
    allowedChannels: allowed,
    variables: {},
    sample: {},
    countsTowardLimit: !NO_LIMIT_MODULES.has(module),
    allowEndedMembers: key === 'access.membership_ended',
    sendWhenClosed: CLOSED_OK(key),
    deepLink: null,
    legacy: tpl,
    text: {},
  };
}

// ------------------------------------------------------------------ code definitions
const defs = new Map<string, { module: string; def: TemplateDefinition }>();

/** 8.38 `registerTemplates(module, defs)`: at import time. Validates the key and every placeholder (BR-16-50, BR-16-51). */
export function registerTemplates(module: string, list: TemplateDefinition[]): void {
  for (const d of list) {
    if (d.key.length > 80 || !TEMPLATE_KEY_RE.test(d.key))
      throw new NotifyError(ERR.templateInvalid, `Template key "${d.key}" is invalid`);
    if (!d.defaultChannels.every(c => d.allowedChannels.includes(c)))
      throw new NotifyError(
        ERR.templateInvalid,
        `Template ${d.key}: allowedChannels must contain defaultChannels`,
      );
    if (!d.text['en-IN']) throw new NotifyError(ERR.templateInvalid, `Template ${d.key} has no en-IN text`);
    for (const [locale, t] of Object.entries(d.text))
      for (const v of Object.values(t ?? {}))
        if (typeof v === 'string')
          for (const p of placeholdersOf(v))
            if (!(p in d.variables))
              throw new NotifyError(
                ERR.templateInvalid,
                `Template ${d.key} (${locale}): unknown placeholder {{${p}}}`,
              );
    defs.set(d.key, { module, def: d });
  }
}
// module 16 owns the `communication.*` keys and registers `reports.*` for module 24 and `resident.*` for module 25 (10.1)
for (const [module, prefix] of [
  ['16', 'communication.'],
  ['24', 'reports.'],
  ['25', 'resident.'],
] as const)
  registerTemplates(
    module,
    COMMUNICATION_TEMPLATES.filter(d => d.key.startsWith(prefix)),
  );

export const codeDefinitions = (): TemplateDefinition[] => [...defs.values()].map(x => x.def);

function defMeta(module: string, d: TemplateDefinition): TemplateMeta {
  return {
    key: d.key,
    module,
    scope: d.scope,
    category: d.category,
    deliveryClass: d.deliveryClass,
    defaultChannels: d.defaultChannels,
    allowedChannels: d.allowedChannels,
    variables: d.variables,
    sample: d.sample,
    countsTowardLimit: d.countsTowardLimit ?? true,
    allowEndedMembers: d.allowEndedMembers ?? false,
    sendWhenClosed: d.sendWhenClosed ?? false,
    deepLink: d.deepLink ?? null,
    legacy: null,
    text: d.text as Record<string, ChannelTexts>,
  };
}
function futureMeta(f: (typeof FUTURE_TEMPLATES)[number]): TemplateMeta {
  const [module, key, category, deliveryClass, channels] = f;
  return {
    key,
    module,
    scope: 'SOCIETY',
    category,
    deliveryClass,
    defaultChannels: channels,
    allowedChannels: withAllowed(deliveryClass, channels),
    variables: {},
    sample: {},
    countsTowardLimit: true,
    allowEndedMembers: false,
    sendWhenClosed: false,
    deepLink: null,
    legacy: null,
    text: {},
  };
}
const FUTURE = new Map(FUTURE_TEMPLATES.map(f => [f[1], f]));

/** Metadata of a key from code: a definition, a legacy template, or a not-yet-built module's key. Null when nobody registered it. */
export function metaFor(key: string): TemplateMeta | null {
  const d = defs.get(key);
  if (d) return defMeta(d.module, d.def);
  const l = getLegacyTemplate(key);
  if (l) return legacyMeta(key, l);
  const f = FUTURE.get(key);
  return f ? futureMeta(f) : null;
}
export function allMeta(): TemplateMeta[] {
  const out = new Map<string, TemplateMeta>();
  for (const f of FUTURE_TEMPLATES) out.set(f[1], futureMeta(f));
  for (const k of legacyTemplateKeys()) out.set(k, legacyMeta(k, getLegacyTemplate(k)!));
  for (const { module, def } of defs.values()) out.set(def.key, defMeta(module, def));
  return [...out.values()];
}

// ------------------------------------------------------------------ sync (templates:sync)
const TEXT_COLS = [
  'inAppTitle',
  'inAppBody',
  'pushTitle',
  'pushBody',
  'smsBody',
  'smsDltTemplateId',
  'smsDltCategory',
  'whatsappTemplateName',
  'whatsappCategory',
  'whatsappParams',
  'whatsappButtonVar',
  'whatsappStatus',
  'emailSubject',
  'emailHtml',
  'emailText',
] as const;

function metaColumns(m: TemplateMeta) {
  return {
    module: m.module,
    scope: m.scope,
    category: m.category,
    deliveryClass: m.deliveryClass,
    defaultChannels: m.defaultChannels,
    allowedChannels: m.allowedChannels,
    variablesSchema: m.variables,
    countsTowardLimit: m.countsTowardLimit,
    allowEndedMembers: m.allowEndedMembers,
    sendWhenClosed: m.sendWhenClosed,
    deepLink: m.deepLink,
  };
}
function textColumns(m: TemplateMeta, locale: string): Record<string, unknown> {
  const t = (m.text[locale] ?? {}) as ChannelTexts;
  const dev = env().NODE_ENV !== 'production';
  const wantsSms = m.allowedChannels.includes('SMS');
  const out: Record<string, unknown> = {};
  for (const c of TEXT_COLS) out[c] = (t as Record<string, unknown>)[c] ?? null;
  // development seeds use the fake DLT id (10.2); production leaves it NULL until the platform team registers it
  if (dev && wantsSms && !out.smsDltTemplateId && (m.legacy !== null || t.smsBody))
    out.smsDltTemplateId = FAKE_DLT_ID;
  if (dev && out.whatsappTemplateName && !out.whatsappStatus) out.whatsappStatus = 'APPROVED';
  return out;
}

/** MySQL stores JSON objects with sorted keys, so compare canonical forms. */
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, x]) => [k, canon(x)]),
        )
      : (v ?? null);
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** The rows (one per locale) a key should have, as column maps. */
function rowsOf(
  m: TemplateMeta,
): { locale: string; cols: Record<string, unknown>; text: Record<string, unknown> }[] {
  const locales = Object.keys(m.text).length ? Object.keys(m.text) : ['en-IN'];
  if (!locales.includes('en-IN')) locales.push('en-IN');
  return locales.map(locale => ({ locale, cols: metaColumns(m), text: textColumns(m, locale) }));
}

/**
 * Upserts keys in bulk (one read, chunked inserts, an UPDATE only for rows whose metadata or untouched text changed). Never overwrites text with
 * `textEditedAt` set. Returns the number of rows written.
 */
export async function syncMetas(list: TemplateMeta[]): Promise<number> {
  if (!list.length) return 0;
  const existing = new Map(
    (await NotificationTemplate.findAll({ where: { templateKey: list.map(m => m.key) } })).map(r => [
      `${r.templateKey}|${r.locale}`,
      r,
    ]),
  );
  const inserts: Record<string, unknown>[] = [];
  let written = 0;
  for (const m of list)
    for (const { locale, cols, text } of rowsOf(m)) {
      const row = existing.get(`${m.key}|${locale}`);
      if (!row) {
        inserts.push({ templateKey: m.key, locale, ...cols, ...text, isActive: true, version: 1 });
        continue;
      }
      const patch: Record<string, unknown> = { ...cols };
      if (!row.textEditedAt) Object.assign(patch, text);
      const changed = Object.entries(patch).some(
        ([k, v]) => !sameJson((row as unknown as Record<string, unknown>)[k], v),
      );
      if (changed) {
        row.set(patch as never);
        row.version += 1;
        await row.save();
        written++;
      }
    }
  for (let i = 0; i < inserts.length; i += 100) {
    await NotificationTemplate.bulkCreate(inserts.slice(i, i + 100) as never[], { ignoreDuplicates: true });
    written += Math.min(100, inserts.length - i);
  }
  return written;
}
export const syncKey = (m: TemplateMeta): Promise<number> => syncMetas([m]);

/** The `templates:sync` seeder (BR-16-50, 10.2): every registered, legacy and future key. Idempotent. */
export async function syncTemplates(): Promise<{ keys: number; written: number }> {
  const all = allMeta();
  return { keys: all.length, written: await syncMetas(all) };
}

/** Deactivated keys are never recreated: only a missing row is inserted by the lazy path. */
export async function ensureKey(key: string): Promise<boolean> {
  const m = metaFor(key);
  if (!m) return false;
  const have = await NotificationTemplate.count({ where: { templateKey: key, locale: 'en-IN' } });
  if (have) return true;
  await syncKey(m);
  return true;
}
