import { randomInt } from 'node:crypto';
import { Op, UniqueConstraintError, type Transaction } from 'sequelize';
import type { ZodType } from 'zod';
import { Incident, ServiceProvider, sequelize } from '../../models';
import type { ProviderChannel, ProviderHealth, ProviderVendor } from '../../models/service-provider.model';
import { now } from '../../lib/clock';
import { logger, maskEmail, maskPhone } from '../../lib/logger';
import { enqueueAfterCommit } from '../../lib/queue';
import { buildProviderAdapter } from '../../adapters/provider-adapter';
import { audit } from '../../utils/audit';
import {
  AppError,
  ConflictError,
  UnprocessableError,
  ValidationError,
  type FieldError,
} from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { AUDIT, COMPONENT_FOR_CHANNEL, ENTITY, JOBS, PLATFORM_OPS_QUEUE } from './platform-ops.types';
import { activeKeyVersion, encryptCredentials, maskCredentials } from './platform-ops.crypto';
import {
  configSchema,
  credentialsSchema,
  credentialsSource,
  vendorAllowedFor,
} from './platform-ops.providers.schemas';
import { credentialsOf } from './platform-ops.providers.registry';
import {
  emitOps,
  inProduction,
  invalidateStatusAfterCommit,
  providerEvents,
  providerNotFound,
  staleVersion,
} from './platform-ops.shared';
import {
  openProviderIncident,
  resolveIncidentRow,
  unresolvedIncidentsOfProvider,
} from './platform-ops.incidents.service';
import { notifyAfterCommit, platformUsersWith } from './platform-ops.notify';
import { getPlatformSetting } from './platform-ops.settings.service';

/** Service providers (module 07 section 8.5): CRUD, credentials, status override, test send. Health checks are in `.providers.health.ts`. */
const GUARDED_CHANNELS: ProviderChannel[] = ['SMS', 'EMAIL', 'PAYMENT_GATEWAY'];
const TIMEOUT_MS = 10_000;

export function providersChangedAfterCommit(t: Transaction): void {
  t.afterCommit(() => {
    providerEvents.emit('platform-ops:providers-changed');
  });
}

export async function providerView(p: ServiceProvider, openIncidentId?: number | null) {
  let incidentId = openIncidentId;
  if (incidentId === undefined)
    incidentId =
      (
        await Incident.findOne({
          where: { serviceProviderId: p.id!, status: { [Op.ne]: 'RESOLVED' } },
          attributes: ['id'],
          order: [['id', 'ASC']],
        })
      )?.id ?? null;
  return {
    id: p.id!,
    providerKey: p.providerKey,
    channel: p.channel,
    vendor: p.vendor,
    displayName: p.displayName,
    description: p.description,
    isEnabled: p.isEnabled,
    priority: p.priority,
    credentialsSource: p.credentialsSource,
    config: p.configJson,
    credentialsMasked: p.credentialsMasked,
    credentialsUpdatedAt: p.credentialsUpdatedAt,
    health: {
      status: p.healthStatus,
      mode: p.statusMode,
      reason: p.statusReason,
      changedAt: p.statusChangedAt,
      consecutiveFailures: p.consecutiveFailures,
      lastCheckAt: p.lastCheckAt,
      lastCheckOk: p.lastCheckOk,
      lastCheckLatencyMs: p.lastCheckLatencyMs,
      lastCheckError: p.lastCheckError,
      degradedLatencyMs: p.degradedLatencyMs,
      uptime30dPct: p.uptime30dPct === null ? null : Number(p.uptime30dPct),
    },
    lastTest: p.lastTestAt ? { at: p.lastTestAt, ok: p.lastTestOk } : null,
    openIncidentId: incidentId,
    version: p.version,
    updatedAt: p.updatedAt,
  };
}

/** Field names only, never values (BR-07-21): credential errors must not echo what was typed. */
function fieldErrors(err: {
  issues: { path: PropertyKey[]; code: string; keys?: string[] }[];
}): FieldError[] {
  return err.issues.flatMap(i =>
    i.code === 'unrecognized_keys'
      ? (i.keys ?? []).map(k => ({ field: k, message: 'Unknown field' }))
      : [{ field: i.path.map(String).join('.') || 'credentials', message: 'Invalid or missing value' }],
  );
}

function parseConfig(
  vendor: ProviderVendor,
  channel: ProviderChannel,
  config: unknown,
): Record<string, unknown> {
  const r = (configSchema(vendor, channel) as ZodType<Record<string, unknown>>).safeParse(config);
  if (!r.success)
    throw new AppError(
      400,
      'CONFIG_SCHEMA_INVALID',
      'The settings do not match this vendor',
      r.error.issues.flatMap(i =>
        i.code === 'unrecognized_keys'
          ? i.keys.map(k => ({ field: `config.${k}`, message: 'Unknown field' }))
          : [{ field: ['config', ...i.path.map(String)].join('.'), message: i.message }],
      ),
    );
  return r.data;
}

function parseCredentials(
  vendor: ProviderVendor,
  channel: ProviderChannel,
  config: Record<string, unknown>,
  creds: unknown,
): Record<string, string> | null {
  const schema = credentialsSchema(vendor, channel);
  if (schema === null) {
    if (creds !== undefined && creds !== null && Object.keys(creds as object).length)
      throw new UnprocessableError(
        'CREDENTIALS_NOT_APPLICABLE',
        'This vendor takes its credentials from the environment',
      );
    return null;
  }
  const r = (schema as ZodType<Record<string, string>>).safeParse(creds ?? {});
  if (!r.success)
    throw new AppError(
      400,
      'CREDENTIALS_SCHEMA_INVALID',
      'The credentials do not match this vendor',
      fieldErrors(r.error as never),
    );
  if (vendor === 'RAZORPAY') {
    const mode = config.mode === 'live' ? 'live' : 'test';
    if (!r.data.keyId!.startsWith(`rzp_${mode}_`))
      throw new AppError(400, 'CREDENTIALS_SCHEMA_INVALID', 'The key id does not match the mode', [
        { field: 'keyId', message: 'Invalid or missing value' },
      ]);
  }
  return r.data;
}

const fakeInProduction = () =>
  new UnprocessableError('FAKE_PROVIDER_IN_PRODUCTION', 'The fake vendor cannot be used in production');

async function assertPriorityFree(channel: ProviderChannel, priority: number, exceptId?: number) {
  const taken = await ServiceProvider.findOne({
    where: { channel, priority, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) },
    attributes: ['id'],
  });
  if (taken)
    throw new ConflictError('PROVIDER_PRIORITY_TAKEN', 'Another provider of this channel has that priority');
}

const mapUnique = (err: unknown): never => {
  if (err instanceof UniqueConstraintError) {
    const name = String((err as UniqueConstraintError).parent?.message ?? '');
    if (name.includes('uq_sp_key'))
      throw new ConflictError('PROVIDER_KEY_TAKEN', 'This provider key was used before');
    throw new ConflictError('PROVIDER_PRIORITY_TAKEN', 'Another provider of this channel has that priority');
  }
  throw err;
};

// ------------------------------------------------------------------ read
export async function listProviders(q: { channel?: string; isEnabled?: boolean; healthStatus?: string }) {
  const where: Record<string, unknown> = {};
  if (q.channel) where.channel = q.channel;
  if (q.isEnabled !== undefined) where.isEnabled = q.isEnabled;
  if (q.healthStatus) where.healthStatus = q.healthStatus;
  const rows = await ServiceProvider.findAll({
    where,
    order: [
      ['channel', 'ASC'],
      ['priority', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const open = rows.length
    ? await Incident.findAll({
        where: { serviceProviderId: { [Op.in]: rows.map(r => r.id!) }, status: { [Op.ne]: 'RESOLVED' } },
        attributes: ['id', 'serviceProviderId'],
        order: [['id', 'DESC']],
      })
    : [];
  const byProvider = new Map(open.map(i => [i.serviceProviderId!, i.id!]));
  return { items: await Promise.all(rows.map(r => providerView(r, byProvider.get(r.id!) ?? null))) };
}

export async function getProvider(id: number) {
  const p = await ServiceProvider.findByPk(id);
  if (!p) throw providerNotFound();
  return providerView(p);
}

// ------------------------------------------------------------------ create (8.5)
export interface CreateProviderInput {
  providerKey: string;
  channel: ProviderChannel;
  vendor: ProviderVendor;
  displayName: string;
  description?: string;
  priority: number;
  config: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  degradedLatencyMs?: number;
}

export async function createProvider(ctx: Ctx, input: CreateProviderInput) {
  if (!vendorAllowedFor(input.vendor, input.channel))
    throw new AppError(
      400,
      'VENDOR_NOT_ALLOWED_FOR_CHANNEL',
      `${input.vendor} cannot serve ${input.channel}`,
    );
  if (input.vendor === 'FAKE' && inProduction()) throw fakeInProduction();
  const config = parseConfig(input.vendor, input.channel, input.config);
  const creds = parseCredentials(input.vendor, input.channel, config, input.credentials);
  if (
    await ServiceProvider.findOne({
      where: { providerKey: input.providerKey },
      paranoid: false,
      attributes: ['id'],
    })
  )
    throw new ConflictError('PROVIDER_KEY_TAKEN', 'This provider key was used before');
  await assertPriorityFree(input.channel, input.priority);
  const sealed = creds ? encryptCredentials(input.providerKey, creds) : null;
  const at = now();
  try {
    const id = await sequelize.transaction(async t => {
      const p = await ServiceProvider.create(
        {
          providerKey: input.providerKey,
          channel: input.channel,
          vendor: input.vendor,
          displayName: input.displayName,
          description: input.description ?? null,
          isEnabled: false,
          priority: input.priority,
          credentialsSource: credentialsSource(input.vendor),
          configJson: config,
          credentialsEnc: sealed?.enc ?? null,
          credentialsIv: sealed?.iv ?? null,
          credentialsTag: sealed?.tag ?? null,
          credentialsKeyVersion: sealed?.keyVersion ?? null,
          credentialsMasked: creds ? maskCredentials(creds) : null,
          credentialsUpdatedAt: creds ? at : null,
          credentialsUpdatedBy: creds ? (ctx.user?.id ?? null) : null,
          healthStatus: 'UNKNOWN',
          statusMode: 'AUTOMATIC',
          statusReason: null,
          statusChangedAt: null,
          consecutiveFailures: 0,
          degradedLatencyMs: input.degradedLatencyMs ?? 3000,
          lastCheckAt: null,
          lastCheckOk: null,
          lastCheckLatencyMs: null,
          lastCheckError: null,
          uptime30dPct: null,
          lastTestAt: null,
          lastTestOk: null,
          lastTestBy: null,
          version: 1,
          createdBy: ctx.user?.id ?? null,
          updatedBy: null,
        },
        { transaction: t },
      );
      await audit(
        ctx,
        {
          action: AUDIT.providerCreated,
          entityType: ENTITY.provider,
          entityId: p.id!,
          entityLabel: p.displayName,
          after: {
            providerKey: p.providerKey,
            channel: p.channel,
            vendor: p.vendor,
            priority: p.priority,
            config: p.configJson,
            updated: creds ? ['credentials'] : [],
          },
        },
        t,
      );
      providersChangedAfterCommit(t);
      return p.id!;
    });
    return await getProvider(id);
  } catch (err) {
    return mapUnique(err);
  }
}

// ------------------------------------------------------------------ edit, enable, disable
const lockWithSecrets = async (id: number, t: Transaction): Promise<ServiceProvider> => {
  const p = await ServiceProvider.scope('withSecrets').findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
  if (!p) throw providerNotFound();
  return p;
};

export async function updateProvider(
  ctx: Ctx,
  id: number,
  patch: {
    version: number;
    displayName?: string;
    description?: string | null;
    priority?: number;
    config?: Record<string, unknown>;
    isEnabled?: boolean;
    degradedLatencyMs?: number;
  },
) {
  try {
    await sequelize.transaction(async t => {
      const p = await lockWithSecrets(id, t);
      if (p.version !== patch.version) throw staleVersion('provider');
      const before = {
        displayName: p.displayName,
        description: p.description,
        priority: p.priority,
        config: p.configJson,
        isEnabled: p.isEnabled,
        degradedLatencyMs: p.degradedLatencyMs,
      };
      const next: Record<string, unknown> = {};
      if (patch.config !== undefined) next.configJson = parseConfig(p.vendor, p.channel, patch.config);
      if (patch.priority !== undefined && patch.priority !== p.priority) {
        await assertPriorityFree(p.channel, patch.priority, p.id!);
        next.priority = patch.priority;
      }
      if (patch.displayName !== undefined) next.displayName = patch.displayName;
      if (patch.description !== undefined) next.description = patch.description;
      if (patch.degradedLatencyMs !== undefined) next.degradedLatencyMs = patch.degradedLatencyMs;
      if (patch.isEnabled !== undefined && patch.isEnabled !== p.isEnabled) {
        if (patch.isEnabled) {
          if (p.vendor === 'FAKE' && inProduction()) throw fakeInProduction();
          if (p.credentialsSource === 'DATABASE' && !p.credentialsEnc)
            throw new UnprocessableError(
              'PROVIDER_CREDENTIALS_MISSING',
              'Add the credentials before enabling this provider',
            );
        } else if (inProduction() && GUARDED_CHANNELS.includes(p.channel)) {
          const others = await ServiceProvider.count({
            where: { channel: p.channel, isEnabled: true, id: { [Op.ne]: p.id! } },
            transaction: t,
          });
          if (others === 0)
            throw new ConflictError(
              'LAST_ENABLED_PROVIDER',
              'This is the last enabled provider of its channel',
            );
        }
        next.isEnabled = patch.isEnabled;
      }
      await p.update(
        { ...next, version: p.version + 1, updatedBy: ctx.user?.id ?? null },
        { transaction: t },
      );
      await audit(
        ctx,
        {
          action: AUDIT.providerUpdated,
          entityType: ENTITY.provider,
          entityId: p.id!,
          entityLabel: p.displayName,
          before,
          after: {
            displayName: p.displayName,
            description: p.description,
            priority: p.priority,
            config: p.configJson,
            isEnabled: p.isEnabled,
            degradedLatencyMs: p.degradedLatencyMs,
          },
        },
        t,
      );
      providersChangedAfterCommit(t);
      invalidateStatusAfterCommit(t);
    });
  } catch (err) {
    mapUnique(err);
  }
  return getProvider(id);
}

// ------------------------------------------------------------------ credentials (PUT)
export async function replaceCredentials(
  ctx: Ctx,
  id: number,
  input: { version: number; credentials: Record<string, unknown> },
) {
  await sequelize.transaction(async t => {
    const p = await lockWithSecrets(id, t);
    if (p.version !== input.version) throw staleVersion('provider');
    if (credentialsSchema(p.vendor, p.channel) === null)
      throw new UnprocessableError(
        'CREDENTIALS_NOT_APPLICABLE',
        'This vendor takes its credentials from the environment',
      );
    const creds = parseCredentials(p.vendor, p.channel, p.configJson, input.credentials)!;
    const sealed = encryptCredentials(p.providerKey, creds, activeKeyVersion());
    await p.update(
      {
        credentialsEnc: sealed.enc,
        credentialsIv: sealed.iv,
        credentialsTag: sealed.tag,
        credentialsKeyVersion: sealed.keyVersion,
        credentialsMasked: maskCredentials(creds),
        credentialsUpdatedAt: now(),
        credentialsUpdatedBy: ctx.user?.id ?? null,
        consecutiveFailures: 0,
        version: p.version + 1,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.providerCredentialsUpdated,
        entityType: ENTITY.provider,
        entityId: p.id!,
        entityLabel: p.displayName,
        after: { updated: ['credentials'], keyVersion: sealed.keyVersion },
      },
      t,
    );
    providersChangedAfterCommit(t);
    enqueueAfterCommit(t, PLATFORM_OPS_QUEUE, JOBS.providerHealthCheck, { providerId: p.id! });
  });
  return getProvider(id);
}

// ------------------------------------------------------------------ delete
export async function deleteProvider(ctx: Ctx, id: number, input: { version: number; reason: string }) {
  await sequelize.transaction(async t => {
    const p = await lockWithSecrets(id, t);
    if (p.version !== input.version) throw staleVersion('provider');
    if (p.isEnabled) throw new ConflictError('PROVIDER_IN_USE', 'Disable this provider before deleting it');
    const before = { providerKey: p.providerKey, channel: p.channel, priority: p.priority };
    await p.update(
      {
        isEnabled: false,
        priority: null,
        credentialsEnc: null,
        credentialsIv: null,
        credentialsTag: null,
        credentialsKeyVersion: null,
        credentialsMasked: null,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    );
    await p.destroy({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.providerDeleted,
        entityType: ENTITY.provider,
        entityId: p.id!,
        entityLabel: p.displayName,
        before,
        reason: input.reason,
      },
      t,
    );
    providersChangedAfterCommit(t);
    invalidateStatusAfterCommit(t);
  });
}

// ------------------------------------------------------------------ manual status (BR-07-28)
const worse = (s: ProviderHealth) => (s === 'OUTAGE' ? 'down' : 'degraded');

export async function setProviderStatus(
  ctx: Ctx,
  id: number,
  input: { version: number; mode: 'MANUAL' | 'AUTOMATIC'; status?: ProviderHealth; reason?: string },
) {
  const alerts = await getPlatformSetting('alerts.providerDown');
  let incidentId: number | null = null;
  await sequelize.transaction(async t => {
    const p = await lockWithSecrets(id, t);
    if (p.version !== input.version) throw staleVersion('provider');
    const at = now();
    const from = p.healthStatus;
    const beforeMode = p.statusMode;
    if (input.mode === 'AUTOMATIC') {
      if (p.statusMode === 'AUTOMATIC')
        throw new ConflictError('INVALID_STATE', 'This provider is already on automatic checks');
      await p.update(
        {
          statusMode: 'AUTOMATIC',
          statusReason: null,
          statusChangedAt: at,
          version: p.version + 1,
          updatedBy: ctx.user?.id ?? null,
        },
        { transaction: t },
      );
    } else {
      const to = input.status!;
      if (p.statusMode === 'MANUAL' && p.healthStatus === to)
        throw new ConflictError('INVALID_STATE', 'This status is already set');
      const open = await unresolvedIncidentsOfProvider(p.id!, t);
      if (to === 'DEGRADED' || to === 'OUTAGE') {
        if (open.length) incidentId = null;
        else {
          const i = await openProviderIncident(ctx, t, p, {
            severity: to === 'OUTAGE' ? 'SEV2' : 'SEV3',
            title: `${p.displayName} is ${worse(to)}: ${input.reason}`,
            message: input.reason!,
            source: 'PROVIDER_MANUAL',
            isPublic: true,
            components: [COMPONENT_FOR_CHANNEL[p.channel]!],
          });
          incidentId = i.id!;
        }
      } else if (to === 'OPERATIONAL') {
        for (const i of open)
          await resolveIncidentRow(ctx, t, i, {
            message: `Resolved: ${input.reason}`,
            rootCause: input.reason!,
            by: { userId: ctx.user?.id ?? null, name: ctx.user?.name ?? 'SocietyApp' },
            skipProviderReset: true,
          });
      }
      await p.update(
        {
          statusMode: 'MANUAL',
          healthStatus: to,
          statusReason: input.reason!,
          statusChangedAt: at,
          version: p.version + 1,
          updatedBy: ctx.user?.id ?? null,
        },
        { transaction: t },
      );
    }
    await audit(
      ctx,
      {
        action: AUDIT.providerStatusSet,
        entityType: ENTITY.provider,
        entityId: p.id!,
        entityLabel: p.displayName,
        before: { mode: beforeMode, status: from },
        after: { mode: p.statusMode, status: p.healthStatus },
        reason: input.reason ?? null,
      },
      t,
    );
    if (alerts && from !== p.healthStatus)
      notifyAfterCommit(
        t,
        'platform.provider.status_changed',
        () => platformUsersWith('platform.dashboard.view'),
        {
          provider: p.displayName,
          from,
          to: p.healthStatus,
          manual: true,
          reason: input.reason ?? null,
          link: '/health',
        },
      );
    emitOps(t, 'platform.provider.status_changed', { providerId: p.id!, healthStatus: p.healthStatus });
    providersChangedAfterCommit(t);
    invalidateStatusAfterCommit(t);
  });
  return { provider: await getProvider(id), incidentId };
}

// ------------------------------------------------------------------ test send (BR-07-30)
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out')), ms);
    p.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
export { withTimeout };

/** Strips every credential value from a vendor error message before it is stored or returned. */
export function scrub(message: string, creds: Record<string, string> | null): string {
  let out = message;
  for (const v of Object.values(creds ?? {})) if (v.length >= 4) out = out.split(v).join('[REDACTED]');
  return out.slice(0, 300);
}

const MESSAGING: ProviderChannel[] = ['SMS', 'WHATSAPP', 'EMAIL'];

export async function testSend(ctx: Ctx, id: number, input: { to?: string; pushSubscriptionOfMe?: boolean }) {
  const p = await ServiceProvider.scope('withSecrets').findByPk(id);
  if (!p) throw providerNotFound();
  if (MESSAGING.includes(p.channel)) {
    if (!input.to)
      throw new UnprocessableError('TEST_RECIPIENT_REQUIRED', 'Enter a recipient for the test message');
    const ok =
      p.channel === 'EMAIL'
        ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to) && input.to.length <= 254
        : /^[6-9]\d{9}$/.test(input.to);
    if (!ok) throw new ValidationError([{ field: 'to', message: 'Not a valid recipient for this channel' }]);
  } else if (input.to !== undefined)
    throw new ValidationError([{ field: 'to', message: 'Not allowed for this channel' }]);
  if (p.channel === 'PUSH') {
    if (input.pushSubscriptionOfMe !== true)
      throw new ValidationError([{ field: 'pushSubscriptionOfMe', message: 'Must be true for push' }]);
    // module 16 owns push subscriptions; until it exists nobody has one
    throw new UnprocessableError('TEST_RECIPIENT_REQUIRED', 'You have no push subscription on this device');
  }
  if (p.credentialsSource === 'DATABASE' && !p.credentialsEnc)
    throw new UnprocessableError('PROVIDER_CREDENTIALS_MISSING', 'Add the credentials first');

  const started = Date.now();
  const creds = credentialsOf(p);
  const adapter = buildProviderAdapter({
    channel: p.channel,
    vendor: p.vendor,
    config: p.configJson,
    credentials: creds,
  });
  let result: { ok: boolean; providerMessageId: string | null; latencyMs: number; error: string | null };
  try {
    if (MESSAGING.includes(p.channel)) {
      const text = `SocietyApp test message ${String(randomInt(0, 1_000_000)).padStart(6, '0')}. No action needed.`;
      const r = await withTimeout(adapter.testSend(input.to!, text), TIMEOUT_MS);
      result = {
        ok: true,
        providerMessageId: r.providerMessageId,
        latencyMs: Date.now() - started,
        error: null,
      };
    } else {
      await withTimeout(adapter.connectionTest(), TIMEOUT_MS);
      result = { ok: true, providerMessageId: null, latencyMs: Date.now() - started, error: null };
    }
  } catch (err) {
    logger.warn({ providerId: p.id }, 'provider test send failed');
    result = {
      ok: false,
      providerMessageId: null,
      latencyMs: Date.now() - started,
      error: scrub(err instanceof Error ? err.message : String(err), creds),
    };
  }
  const masked = input.to ? (p.channel === 'EMAIL' ? maskEmail(input.to) : maskPhone(input.to)) : null;
  await sequelize.transaction(async t => {
    await p.update(
      { lastTestAt: now(), lastTestOk: result.ok, lastTestBy: ctx.user?.id ?? null },
      { transaction: t, silent: true },
    );
    await audit(
      ctx,
      {
        action: AUDIT.providerTestSent,
        entityType: ENTITY.provider,
        entityId: p.id!,
        entityLabel: p.displayName,
        after: { to: masked, ok: result.ok },
      },
      t,
    );
  });
  return result;
}
