import { EventEmitter } from 'node:events';
import { Op, type Transaction } from 'sequelize';
import { PlatformSetting, User, sequelize } from '../../models';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { AppError, UnprocessableError, ValidationError, type FieldError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import {
  SETTING_KEYS,
  crossKeyError,
  isSettingKey,
  settingDef,
  type SettingKey,
  type SettingValue,
} from './platform-ops.settings-registry';
import { SETTING_CATEGORIES, type SettingCategory } from '../../models/platform-setting.model';
import { AUDIT, ENTITY } from './platform-ops.types';
import { ipAllowed } from './platform-ops.ip-allowlist';

/**
 * Platform settings (module 07 sections 7.1 and 8.10). `getStoredSetting` returns the stored, validated value or
 * `undefined` (so a module can keep its own default); `getPlatformSetting` falls back to the registry default.
 * Both are cached for 60 seconds under `ps:<key>` and the cache entry is deleted on update.
 */
const CACHE_TTL_SECONDS = 60;
const cacheKey = (k: string) => `ps:${k}`;

/** `platform-ops:settings-changed` (section 8.10). Redis pub/sub in production is module 16's concern; in process here. */
export const settingsEvents = new EventEmitter();

export async function getStoredSetting<K extends SettingKey>(key: K): Promise<SettingValue<K> | undefined> {
  const c = await kv().cacheGet(cacheKey(key));
  if (c !== null) {
    const parsed = JSON.parse(c) as { v?: unknown };
    return parsed.v as SettingValue<K> | undefined;
  }
  const row = await PlatformSetting.findOne({ where: { settingKey: key } });
  let value: unknown;
  if (row) {
    const r = settingDef(key).schema.safeParse(row.valueJson);
    if (r.success) value = r.data;
    else logger.warn({ key }, 'invalid stored platform setting; using the default');
  }
  await kv().cacheSet(cacheKey(key), JSON.stringify({ v: value }), CACHE_TTL_SECONDS);
  return value as SettingValue<K> | undefined;
}

/** The typed value of a setting: stored, or the registry default when no row exists (section 8.13). */
export async function getPlatformSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const v = await getStoredSetting(key);
  return (v === undefined ? settingDef(key).default : v) as SettingValue<K>;
}

/** Seeder `platform-settings` (all environments): inserts missing keys with their defaults, never overwrites. */
export async function seedPlatformSettings(): Promise<{ added: number }> {
  const have = new Set(
    (await PlatformSetting.findAll({ attributes: ['settingKey'] })).map(r => r.settingKey),
  );
  const rows = SETTING_KEYS.filter(k => !have.has(k)).map(k => {
    const d = settingDef(k);
    return {
      settingKey: k,
      category: d.category,
      valueType: d.type,
      valueJson: d.default,
      isReadOnly: Boolean(d.readOnly),
      description: d.description,
      version: 1,
      createdBy: null,
      updatedBy: null,
    };
  });
  if (rows.length) {
    await PlatformSetting.bulkCreate(rows, { ignoreDuplicates: true });
    await kv().cacheDel(...rows.map(r => cacheKey(r.settingKey))); // a cached "missing" must not hide the new row
  }
  return { added: rows.length };
}

export interface SettingView {
  key: string;
  valueType: string;
  value: unknown;
  isReadOnly: boolean;
  description: string;
  version: number;
  updatedAt: string;
  updatedBy: { id: number; name: string } | null;
}

async function viewRows(): Promise<Record<SettingCategory, SettingView[]>> {
  const rows = await PlatformSetting.findAll({ order: [['id', 'ASC']] });
  const ids = [...new Set(rows.map(r => r.updatedBy).filter((x): x is number => x != null))];
  const users = ids.length
    ? await User.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id', 'name'] })
    : [];
  const name = new Map(users.map(u => [u.id!, u.name ?? 'User']));
  const out = Object.fromEntries(SETTING_CATEGORIES.map(c => [c, [] as SettingView[]])) as Record<
    SettingCategory,
    SettingView[]
  >;
  const byKey = new Map(rows.map(r => [r.settingKey, r]));
  for (const key of SETTING_KEYS) {
    const row = byKey.get(key);
    if (!row || key === 'audit.archiveManifest') continue;
    const d = settingDef(key);
    out[d.category].push({
      key,
      valueType: d.type,
      value: row.valueJson,
      isReadOnly: d.readOnly === true || row.isReadOnly,
      description: d.description,
      version: row.version,
      updatedAt: row.updatedAt!.toISOString(),
      updatedBy: row.updatedBy ? { id: row.updatedBy, name: name.get(row.updatedBy) ?? 'User' } : null,
    });
  }
  return out;
}

/** `GET /platform/settings`: every key by category (missing rows are inserted from the registry first). */
export async function listSettings(): Promise<{ categories: Record<SettingCategory, SettingView[]> }> {
  await seedPlatformSettings();
  return { categories: await viewRows() };
}

export interface SettingChange {
  key: string;
  value: unknown;
  version: number;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** True when the request changes a SECURITY key (it then needs step-up and a reason). */
export const touchesSecurity = (changes: { key: string }[]): boolean =>
  changes.some(c => isSettingKey(c.key) && settingDef(c.key).category === 'SECURITY');

/**
 * `PATCH /platform/settings` (BR-07-48). All or nothing: lock rows, compare versions, validate each value and the
 * cross-key rules against the merged result, update with `version + 1`, one audit row per changed key.
 */
export async function updateSettings(ctx: Ctx, input: { changes: SettingChange[]; reason?: string }) {
  const unknown = input.changes.filter(c => !isSettingKey(c.key));
  if (unknown.length)
    throw new AppError(
      400,
      'UNKNOWN_SETTING_KEY',
      `Unknown setting: ${unknown.map(u => u.key).join(', ')}`,
      unknown.map(u => ({ field: u.key, message: 'Unknown setting key' })),
    );
  const keys = input.changes.map(c => c.key as SettingKey);
  const readOnly = keys.filter(k => settingDef(k).readOnly);
  if (readOnly.length)
    throw new UnprocessableError(
      'SETTING_READ_ONLY',
      `${readOnly.join(', ')} is managed by the system and cannot be changed`,
    );
  if (touchesSecurity(input.changes) && !input.reason)
    throw new ValidationError([
      { field: 'reason', message: 'A reason is required when a security setting changes' },
    ]);

  await seedPlatformSettings();
  const changed: SettingKey[] = [];
  await sequelize.transaction(async t => {
    const rows = await PlatformSetting.findAll({
      where: { settingKey: { [Op.in]: SETTING_KEYS } },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const byKey = new Map(rows.map(r => [r.settingKey as SettingKey, r]));
    const stale = input.changes.filter(c => byKey.get(c.key as SettingKey)?.version !== c.version);
    if (stale.length)
      throw new AppError(
        409,
        'STALE_VERSION',
        'Settings changed since you opened them. Reload and try again.',
        stale.map(s => ({ field: s.key, message: 'Version mismatch' })),
      );
    const errors: FieldError[] = [];
    const next = new Map<SettingKey, unknown>();
    for (const c of input.changes) {
      const r = settingDef(c.key as SettingKey).schema.safeParse(c.value);
      if (r.success) next.set(c.key as SettingKey, r.data);
      else for (const i of r.error.issues) errors.push({ field: c.key, message: i.message });
    }
    if (errors.length)
      throw new AppError(400, 'SETTING_VALUE_INVALID', 'A setting value is not valid', errors);

    const merged = (k: SettingKey): unknown =>
      next.has(k) ? next.get(k) : (byKey.get(k)?.valueJson ?? settingDef(k).default);
    const cross = crossKeyError(merged);
    if (cross) {
      const touched = cross.keys.some(k => next.has(k));
      if (touched) throw new UnprocessableError(cross.code, cross.message);
    }
    if (next.has('security.ipAllowlist')) {
      const list = next.get('security.ipAllowlist') as string[];
      if (list.length && !ipAllowed(ctx.ip, list))
        throw new UnprocessableError(
          'ALLOWLIST_EXCLUDES_YOU',
          'Your current IP address is not in this list. Add it or you would lock yourself out.',
        );
    }
    for (const [key, value] of next) {
      const row = byKey.get(key)!;
      if (same(row.valueJson, value)) continue;
      const before = row.valueJson;
      await row.update(
        { valueJson: value, version: row.version + 1, updatedBy: ctx.user?.id ?? null },
        { transaction: t },
      );
      await audit(
        ctx,
        {
          action: AUDIT.settingUpdated,
          entityType: ENTITY.setting,
          entityId: key,
          before: { value: before, version: row.version - 1 },
          after: { value, version: row.version },
          reason: input.reason ?? null,
        },
        t,
      );
      changed.push(key);
    }
    if (changed.length) afterCommitInvalidate(t, changed);
  });
  return listSettings();
}

function afterCommitInvalidate(t: Transaction, keys: SettingKey[]): void {
  t.afterCommit(async () => {
    await kv().cacheDel(...keys.map(cacheKey));
    settingsEvents.emit('platform-ops:settings-changed', { keys });
  });
}

/** Drops cached settings (tests and the worker after a direct database change). */
export const clearSettingsCache = (): Promise<void> => kv().cacheDelPrefix('ps:');
