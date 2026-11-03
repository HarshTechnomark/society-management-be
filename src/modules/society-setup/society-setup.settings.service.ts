import { Op, QueryTypes, type Transaction } from 'sequelize';
import { NumberSequence, Society, SocietySetting, sequelize } from '../../models';
import { kv } from '../../lib/kv';
import { logger, maskPhone } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { financialYearOf } from '../../utils/numberSequences';
import { AppError, UnprocessableError, ValidationError, type FieldError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import {
  SETTING_KEYS,
  SETTINGS_REGISTRY,
  isSettingKey,
  settingDef,
  type SettingNamespace,
  type SettingValue,
} from './society-setup.settings-registry';
import { AUDIT, ENTITY } from './society-setup.types';
import { emitAdmin, notifyAfterCommit, recipients } from './society-setup.notify';

/**
 * Society settings (module 08 sections 5.2, 7.3, 8.4, 8.5, 8.30). Reads merge stored rows over the registry defaults
 * and go through a cache (`ss:set:<societyId>`, 300 s; Redis in production, memory without `REDIS_URL`) that is deleted
 * in `afterCommit` of every save. All writes, from the route and from other modules, go through `setMany`.
 */
const CACHE_TTL_SECONDS = 300;
const cacheKey = (societyId: number): string => `ss:set:${societyId}`;

interface Stored {
  value: unknown;
  version: number;
}
type StoredMap = Map<string, Stored>;

/** Canonical JSON (sorted keys) so two equal objects compare equal whatever their key order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

async function loadStoredFromDb(societyId: number, t?: Transaction): Promise<StoredMap> {
  const rows = await SocietySetting.findAll({
    where: { societyId },
    attributes: ['settingKey', 'valueJson', 'version'],
    transaction: t,
  });
  return new Map(rows.map(r => [r.settingKey, { value: r.valueJson, version: r.version }]));
}

/** Stored rows of a society. Outside a transaction it uses the cache; a cache failure falls back to MySQL. */
async function loadStored(societyId: number, t?: Transaction): Promise<StoredMap> {
  if (t) return loadStoredFromDb(societyId, t);
  try {
    const hit = await kv().cacheGet(cacheKey(societyId));
    if (hit !== null) return new Map(Object.entries(JSON.parse(hit) as Record<string, Stored>));
  } catch (err) {
    logger.warn({ err }, 'settings cache read failed');
  }
  const map = await loadStoredFromDb(societyId);
  try {
    await kv().cacheSet(cacheKey(societyId), JSON.stringify(Object.fromEntries(map)), CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err }, 'settings cache write failed');
  }
  return map;
}

export async function clearSettingsCache(societyId: number): Promise<void> {
  try {
    await kv().cacheDel(cacheKey(societyId));
  } catch (err) {
    logger.warn({ err }, 'settings cache delete failed');
  }
}

function effective(stored: StoredMap, key: string): unknown {
  const d = settingDef(key);
  const row = stored.get(key);
  if (!row) return d.default;
  const r = d.schema.safeParse(row.value);
  if (r.success) return r.data;
  logger.warn({ key }, 'invalid stored society setting; using the default');
  return d.default;
}

// ------------------------------------------------------------------ reads (section 8.30)
function assertKey(key: string): void {
  if (!isSettingKey(key))
    throw new AppError(400, 'UNKNOWN_SETTING_KEY', `Unknown setting: ${key}`, [
      { field: key, message: 'Unknown setting key' },
    ]);
}

/** Stored or default value of one key (cached). */
export async function get<K extends string>(societyId: number, key: K): Promise<SettingValue<K>> {
  assertKey(key);
  return effective(await loadStored(societyId), key) as SettingValue<K>;
}

export async function getMany(societyId: number, keys: string[]): Promise<Record<string, unknown>> {
  keys.forEach(assertKey);
  const stored = await loadStored(societyId);
  return Object.fromEntries(keys.map(k => [k, effective(stored, k)]));
}

/** Values read inside a caller's transaction (no cache), for services that must see their own writes. */
export async function getManyFresh(
  societyId: number,
  keys: string[],
  t?: Transaction,
): Promise<Record<string, unknown>> {
  keys.forEach(assertKey);
  const stored = await loadStoredFromDb(societyId, t);
  return Object.fromEntries(keys.map(k => [k, effective(stored, k)]));
}

export async function getNamespace(
  societyId: number,
  ns: SettingNamespace,
): Promise<Record<string, unknown>> {
  const stored = await loadStored(societyId);
  return Object.fromEntries(
    SETTING_KEYS.filter(k => settingDef(k).namespace === ns).map(k => [k, effective(stored, k)]),
  );
}

/** Module 02 port `societySettings.getSessionPolicy` (BR-02-36, BR-02-40). */
export async function getSessionPolicy(
  societyId: number,
): Promise<{ adminIdleMinutes: number; stepUpMinutes: number }> {
  const v = await getMany(societyId, ['security.adminIdleMinutes', 'security.stepUpMinutes']);
  return {
    adminIdleMinutes: v['security.adminIdleMinutes'] as number,
    stepUpMinutes: v['security.stepUpMinutes'] as number,
  };
}

// ------------------------------------------------------------------ cross-key rules (BR-08-10)
export interface CrossKeyError {
  code: string;
  message: string;
  keys: string[];
}

/** First broken rule among those that involve a changed key; `merged` returns the value after the change. */
export function crossKeyError(
  merged: (key: string) => unknown,
  touched: ReadonlySet<string>,
  gstin: string | null,
): CrossKeyError | null {
  const involves = (...keys: string[]) => keys.some(k => touched.has(k));
  const num = (k: string) => Number(merged(k));
  if (
    involves('billing.invoicePrefix', 'billing.receiptPrefix') &&
    merged('billing.invoicePrefix') === merged('billing.receiptPrefix')
  )
    return {
      code: 'PREFIX_CLASH',
      message: 'The invoice and receipt prefixes must be different',
      keys: ['billing.invoicePrefix', 'billing.receiptPrefix'],
    };
  if (
    involves('office.openTime', 'office.closeTime') &&
    !((merged('office.openTime') as string) < (merged('office.closeTime') as string))
  )
    return {
      code: 'OFFICE_HOURS_INVALID',
      message: 'The office must open before it closes',
      keys: ['office.openTime', 'office.closeTime'],
    };
  if (
    involves('communication.quietHoursStart', 'communication.quietHoursEnd') &&
    merged('communication.quietHoursStart') === merged('communication.quietHoursEnd')
  )
    return {
      code: 'QUIET_HOURS_INVALID',
      message: 'Quiet hours must start and end at different times',
      keys: ['communication.quietHoursStart', 'communication.quietHoursEnd'],
    };
  if (involves('billing.applyGst') && merged('billing.applyGst') === true && !gstin)
    return {
      code: 'GST_REQUIRES_GSTIN',
      message: 'Add the society GSTIN before charging GST',
      keys: ['billing.applyGst'],
    };
  if (
    involves('billing.lateFeeDefaultMode', 'billing.lateFeeDefaultRatePct', 'billing.lateFeeDefaultFlatPaise')
  ) {
    const mode = merged('billing.lateFeeDefaultMode');
    if (
      (mode === 'SIMPLE_INTEREST' && !(num('billing.lateFeeDefaultRatePct') > 0)) ||
      (mode === 'FLAT' && !(num('billing.lateFeeDefaultFlatPaise') > 0))
    )
      return {
        code: 'LATE_FEE_DEFAULT_INVALID',
        message:
          mode === 'FLAT'
            ? 'A flat late fee needs an amount above zero'
            : 'Interest as late fee needs a rate above zero',
        keys: [
          'billing.lateFeeDefaultMode',
          'billing.lateFeeDefaultRatePct',
          'billing.lateFeeDefaultFlatPaise',
        ],
      };
  }
  if (
    involves('committee.minStrength', 'committee.maxStrength') &&
    num('committee.minStrength') > num('committee.maxStrength')
  )
    return {
      code: 'COMMITTEE_STRENGTH_INVALID',
      message: 'The smallest committee size cannot be above the largest',
      keys: ['committee.minStrength', 'committee.maxStrength'],
    };
  if (
    involves('helpdesk.waitingAutoResolveDays', 'helpdesk.waitingReminderHours') &&
    !(num('helpdesk.waitingAutoResolveDays') * 24 > num('helpdesk.waitingReminderHours'))
  )
    return {
      code: 'HELPDESK_WAITING_RULE_INVALID',
      message: 'Auto-resolve must come after the waiting reminder',
      keys: ['helpdesk.waitingAutoResolveDays', 'helpdesk.waitingReminderHours'],
    };
  return null;
}

// ------------------------------------------------------------------ writes (BR-08-8 to BR-08-13, BR-08-10a)
export interface SettingChange {
  key: string;
  value: unknown;
  /** Version read by the caller (0 = never saved). Omitted by module callers that do not compare. */
  version?: number;
}
export interface SetManyOptions {
  reason?: string;
  /** Route mode: keys that need a reason must have one (BR-08-11). */
  enforceReason?: boolean;
  /** Profile save: the caller writes its own `setup.society.updated` row. */
  skipAudit?: boolean;
}
export interface SetResult {
  key: string;
  value: unknown;
  version: number;
  changed: boolean;
}

const permissionDenied = (keys: string[]) =>
  new AppError(
    403,
    'PERMISSION_DENIED',
    'You do not have permission to change this setting',
    keys.map(k => ({ field: k, message: `Needs ${settingDef(k).editPermission}` })),
  );
const staleVersion = (keys: string[]) =>
  new AppError(
    409,
    'STALE_VERSION',
    'Settings changed since you opened them. Reload and try again.',
    keys.map(k => ({ field: k, message: 'Version mismatch' })),
  );

/** `valueJson` is NOT NULL: a JSON null (clearing a profile value) must be written as the JSON literal, not as SQL NULL. */
const jsonValue = (v: unknown) => (v === null ? sequelize.literal("CAST('null' AS JSON)") : v);

/** The audit value of a key: the office phone is stored masked (section 9.2). */
const auditValue = (key: string, v: unknown): unknown =>
  key === 'profile.contactPhone' && typeof v === 'string' ? maskPhone(v) : v;

/**
 * Saves changes inside the caller's transaction, all or nothing. Validates every value with its registry schema, checks
 * the namespace edit permission when `ctx` is a user, compares versions when they are passed, applies the cross-key
 * rules to the merged result, skips values equal to the stored one, writes one audit row per changed key and, after
 * commit, deletes the cache entry and tells the admin room.
 */
export async function setMany(
  ctx: Ctx,
  societyId: number,
  changes: SettingChange[],
  t: Transaction,
  opts: SetManyOptions = {},
): Promise<SetResult[]> {
  const unknown = changes.filter(c => !isSettingKey(c.key));
  if (unknown.length)
    throw new AppError(
      400,
      'UNKNOWN_SETTING_KEY',
      `Unknown setting: ${unknown.map(u => u.key).join(', ')}`,
      unknown.map(u => ({ field: u.key, message: 'Unknown setting key' })),
    );

  const errors: FieldError[] = [];
  const parsed = new Map<string, unknown>();
  for (const c of changes) {
    const r = settingDef(c.key).schema.safeParse(c.value);
    if (r.success) parsed.set(c.key, r.data);
    else for (const i of r.error.issues) errors.push({ field: c.key, message: i.message });
  }
  if (errors.length) throw new AppError(400, 'SETTING_VALUE_INVALID', 'A setting value is not valid', errors);

  if (ctx.user) {
    const denied = changes
      .filter(c => !ctx.permissions?.has(settingDef(c.key).editPermission))
      .map(c => c.key);
    if (denied.length) throw permissionDenied(denied);
  }

  // Existing rows are locked by id (never by key range: gap locks of two first inserts would deadlock).
  const plain = await SocietySetting.findAll({
    where: { societyId, settingKey: { [Op.in]: changes.map(c => c.key) } },
    attributes: ['id'],
    order: [['id', 'ASC']],
    transaction: t,
  });
  const locked = plain.length
    ? await SocietySetting.findAll({
        where: { id: { [Op.in]: plain.map(p => p.id!) } },
        order: [['id', 'ASC']],
        transaction: t,
        lock: t.LOCK.UPDATE,
      })
    : [];
  const rows = new Map(locked.map(r => [r.settingKey, r]));

  const stale = changes.filter(c => c.version !== undefined && (rows.get(c.key)?.version ?? 0) !== c.version);
  if (stale.length) throw staleVersion(stale.map(s => s.key));

  const stored = (k: string): unknown => {
    const row = rows.get(k);
    if (!row) return settingDef(k).default;
    const r = settingDef(k).schema.safeParse(row.valueJson);
    return r.success ? r.data : settingDef(k).default;
  };
  const toWrite = changes.filter(c => {
    const row = rows.get(c.key);
    return !row || !same(parsed.get(c.key), row.valueJson);
  });

  const touched = new Set(toWrite.map(c => c.key));
  if (touched.size) {
    // keys outside this change keep their stored value; for the cross-key rules read the other keys of the society
    const other = await loadStoredFromDb(societyId, t);
    const merged = (k: string): unknown => (parsed.has(k) ? parsed.get(k) : effective(other, k));
    const gstin = toWrite.some(c => c.key === 'billing.applyGst')
      ? ((await Society.findByPk(societyId, { attributes: ['gstin'], transaction: t }))?.gstin ?? null)
      : null;
    const cross = crossKeyError(merged, touched, gstin);
    if (cross) throw new UnprocessableError(cross.code, cross.message);
  }

  if (opts.enforceReason) {
    const need = toWrite.filter(c => settingDef(c.key).requiresReason);
    if (need.length && (!opts.reason || opts.reason.trim().length < 5 || opts.reason.trim().length > 500))
      throw new ValidationError([
        { field: 'reason', message: 'A reason of 5 to 500 characters is required' },
      ]);
  }

  const results: SetResult[] = [];
  const at = new Date();
  for (const c of changes) {
    const row = rows.get(c.key);
    const value = parsed.get(c.key);
    if (row && !toWrite.includes(c)) {
      results.push({ key: c.key, value, version: row.version, changed: false });
      continue;
    }
    if (row) {
      const before = stored(c.key);
      row.valueJson = jsonValue(value);
      row.version += 1;
      row.updatedBy = ctx.user?.id ?? null;
      await row.save({ transaction: t });
      results.push({ key: c.key, value, version: row.version, changed: true });
      if (!opts.skipAudit)
        await audit(
          ctx,
          {
            action: AUDIT.settingUpdated,
            entityType: ENTITY.setting,
            entityId: c.key,
            before: { value: auditValue(c.key, before), version: row.version - 1 },
            after: { value: auditValue(c.key, value), version: row.version },
            reason: opts.reason ?? null,
            societyId,
          },
          t,
        );
    } else {
      try {
        // a savepoint-free insert: a racing first save hits the unique key and reports a stale version (BR-08-8)
        await SocietySetting.create(
          {
            societyId,
            settingKey: c.key,
            valueJson: jsonValue(value),
            version: 1,
            createdBy: ctx.user?.id ?? null,
            updatedBy: ctx.user?.id ?? null,
            createdAt: at,
            updatedAt: at,
          },
          { transaction: t },
        );
      } catch (err) {
        if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError') throw staleVersion([c.key]);
        throw err;
      }
      results.push({ key: c.key, value, version: 1, changed: true });
      if (!opts.skipAudit)
        await audit(
          ctx,
          {
            action: AUDIT.settingUpdated,
            entityType: ENTITY.setting,
            entityId: c.key,
            before: { value: auditValue(c.key, stored(c.key)), version: 0 },
            after: { value: auditValue(c.key, value), version: 1 },
            reason: opts.reason ?? null,
            societyId,
          },
          t,
        );
    }
  }

  const changedKeys = results.filter(r => r.changed).map(r => r.key);
  if (changedKeys.includes('billing.areaBasis'))
    await recomputeAreas(ctx, societyId, parsed.get('billing.areaBasis') as string, t);
  if (changedKeys.length) {
    t.afterCommit(() => {
      void clearSettingsCache(societyId);
      emitAdmin(societyId, 'setup.settings.updated', { keys: changedKeys });
    });
    if (changedKeys.some(k => settingDef(k).namespace === 'security'))
      notifyAfterCommit(t, 'setup.security_policy.changed', societyId, recipients.editors, {
        actorName: ctx.user?.name ?? 'An administrator',
        keys: changedKeys.filter(k => settingDef(k).namespace === 'security'),
        reason: opts.reason ?? null,
        link: '/settings?tab=security',
      });
  }
  return results;
}

/** BR-08-12: one UPDATE sets every unit's billing area from the column the basis names, and one audit row records the count. */
async function recomputeAreas(ctx: Ctx, societyId: number, basis: string, t: Transaction): Promise<void> {
  const col = (
    {
      CARPET: 'carpetAreaSqft',
      BUILT_UP: 'builtUpAreaSqft',
      SUPER_BUILT_UP: 'superBuiltUpAreaSqft',
    } as Record<string, string>
  )[basis];
  if (!col) throw new Error(`unknown area basis ${basis}`);
  const [, count] = (await sequelize.query(
    `UPDATE units SET areaSqft = ${col}, version = version + 1, updatedAt = :at
      WHERE societyId = :societyId AND NOT (areaSqft <=> ${col})`,
    { replacements: { societyId, at: new Date() }, type: QueryTypes.UPDATE, transaction: t },
  )) as unknown as [unknown, number];
  await audit(
    ctx,
    {
      action: AUDIT.unitAreaRecomputed,
      entityType: ENTITY.society,
      entityId: societyId,
      after: { areaBasis: basis, unitsRecomputed: count },
      societyId,
    },
    t,
  );
}

/** `settings.set` for other modules (BR-08-10a): runs in the caller's transaction. */
export async function set<K extends string>(
  ctx: Ctx,
  societyId: number,
  key: K,
  value: SettingValue<K>,
  t: Transaction,
  opts: { version?: number; reason?: string } = {},
): Promise<{ key: K; value: SettingValue<K>; version: number; changed: boolean }> {
  const [r] = await setMany(ctx, societyId, [{ key, value, version: opts.version }], t, {
    reason: opts.reason,
  });
  return { key, value: r!.value as SettingValue<K>, version: r!.version, changed: r!.changed };
}

// ------------------------------------------------------------------ the settings screen (8.4, 8.5)
export interface SettingView {
  key: string;
  namespace: string;
  type: string;
  value: unknown;
  default: unknown;
  isDefault: boolean;
  version: number;
  canEdit: boolean;
  requiresStepUp: boolean;
  requiresReason: boolean;
  editVia: string;
  rules: Record<string, unknown>;
  description: string;
  appliesFrom?: string;
}

/** BR-08-14: the FY from which a changed prefix applies, when a sequence row of the current year already exists. */
async function prefixAppliesFrom(societyId: number): Promise<string | undefined> {
  const fy = financialYearOf();
  const n = await NumberSequence.count({
    where: { societyId, financialYear: fy, series: { [Op.in]: ['INVOICE', 'RECEIPT'] } },
  });
  if (!n) return undefined;
  const start = Number(fy.slice(0, 4)) + 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

function viewOf(ctx: Ctx, key: string, stored: StoredMap, appliesFrom?: string): SettingView {
  const d = settingDef(key);
  const row = stored.get(key);
  let value = effective(stored, key);
  if (
    key === 'profile.contactPhone' &&
    typeof value === 'string' &&
    !ctx.permissions?.has('residents.contacts.view')
  )
    value = maskPhone(value);
  const out: SettingView = {
    key,
    namespace: d.namespace,
    type: d.type,
    value,
    default: d.default,
    isDefault: !row || same(effective(stored, key), d.default),
    version: row?.version ?? 0,
    canEdit: d.editVia === 'SETTINGS' && Boolean(ctx.permissions?.has(d.editPermission)),
    requiresStepUp: d.requiresStepUp,
    requiresReason: d.requiresReason,
    editVia: d.editVia,
    rules: d.rules,
    description: d.description,
  };
  if ((key === 'billing.invoicePrefix' || key === 'billing.receiptPrefix') && appliesFrom)
    out.appliesFrom = appliesFrom;
  return out;
}

/** `GET /society/settings`: only keys whose namespace view permission the caller holds; MODULE17 keys are hidden. */
export async function listView(ctx: Ctx, societyId: number, namespace?: SettingNamespace) {
  const stored = await loadStored(societyId);
  const appliesFrom = await prefixAppliesFrom(societyId);
  const items = SETTING_KEYS.filter(k => {
    const d = SETTINGS_REGISTRY[k]!;
    return (
      d.editVia !== 'MODULE17' &&
      (!namespace || d.namespace === namespace) &&
      ctx.permissions?.has(d.viewPermission)
    );
  }).map(k => viewOf(ctx, k, stored, appliesFrom));
  return { items };
}

/** `PATCH /society/settings`: the route function (BR-08-9). Rejects keys that are not edited here. */
export async function saveFromRoute(
  ctx: Ctx,
  societyId: number,
  input: { changes: { key: string; value: unknown; version: number }[]; reason?: string },
) {
  const unknown = input.changes.filter(c => !isSettingKey(c.key));
  if (unknown.length)
    throw new AppError(
      400,
      'UNKNOWN_SETTING_KEY',
      `Unknown setting: ${unknown.map(u => u.key).join(', ')}`,
      unknown.map(u => ({ field: u.key, message: 'Unknown setting key' })),
    );
  const elsewhere = input.changes.filter(c => settingDef(c.key).editVia !== 'SETTINGS');
  if (elsewhere.length)
    throw new UnprocessableError(
      'SETTING_NOT_EDITABLE_HERE',
      elsewhere.some(e => settingDef(e.key).editVia === 'PROFILE')
        ? 'Profile settings are edited through the society profile'
        : 'This setting is written by another part of the app',
      elsewhere.map(e => ({ field: e.key, message: 'Not editable here' })),
    );
  await sequelize.transaction(t =>
    setMany(ctx, societyId, input.changes, t, { reason: input.reason, enforceReason: true }),
  );
  const stored = await loadStoredFromDb(societyId);
  const appliesFrom = await prefixAppliesFrom(societyId);
  return { items: input.changes.map(c => viewOf(ctx, c.key, stored, appliesFrom)) };
}

/** Which keys of a request need step-up (route guard). Unknown keys are left to the service to reject. */
export const needsStepUp = (changes: { key: string }[]): boolean =>
  changes.some(c => isSettingKey(c.key) && settingDef(c.key).requiresStepUp);
