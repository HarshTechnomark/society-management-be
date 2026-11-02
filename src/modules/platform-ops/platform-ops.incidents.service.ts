import { Op, type Transaction, type WhereOptions } from 'sequelize';
import { Incident, PlatformNotification, ServiceProvider, sequelize } from '../../models';
import type { IncidentSeverity, IncidentStatus, IncidentUpdate } from '../../models/incident.model';
import { addDays, now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import { UnprocessableError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { AUDIT, ENTITY, incidentNo } from './platform-ops.types';
import {
  actorOf,
  emitOps,
  incidentNotFound,
  invalidState,
  invalidateStatusAfterCommit,
  providerNotFound,
  staleVersion,
} from './platform-ops.shared';
import { notifyAfterCommit, platformUsersWith } from './platform-ops.notify';
import {
  createIncidentAnnouncement,
  expireIncidentAnnouncements,
} from './platform-ops.announcements.service';

/** Incidents and the incident workflow (module 07 sections 6.2, 8.6; BR-07-31 to BR-07-36). */
export const MAX_UPDATES = 100;
const SYSTEM_NAME = 'SocietyApp';

export async function incidentView(i: Incident, announcementId?: number | null) {
  let aId = announcementId;
  if (aId === undefined)
    aId =
      (await PlatformNotification.findOne({ where: { incidentId: i.id! }, attributes: ['id'] }))?.id ?? null;
  return {
    id: i.id!,
    incidentNo: incidentNo(i.id!),
    title: i.title,
    severity: i.severity,
    status: i.status,
    components: i.components,
    serviceProviderId: i.serviceProviderId,
    source: i.source,
    isPublic: i.isPublic,
    startedAt: i.startedAt,
    identifiedAt: i.identifiedAt,
    monitoringAt: i.monitoringAt,
    resolvedAt: i.resolvedAt,
    durationMinutes: i.durationMinutes,
    rootCause: i.rootCause,
    announcementId: aId,
    updates: i.updates.map(u => ({
      at: u.at,
      status: u.status,
      message: u.message,
      isPublic: u.isPublic,
      byName: u.byName,
    })),
    version: i.version,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

const entry = (
  status: IncidentStatus,
  message: string,
  isPublic: boolean,
  by: { userId: number | null; name: string },
): IncidentUpdate => ({
  at: now().toISOString(),
  status,
  message,
  isPublic,
  byUserId: by.userId,
  byName: by.name,
});

/** Appends a system entry when there is room (system entries never fail an automatic transition). */
export function appendSystemUpdate(i: Incident, status: IncidentStatus, message: string): void {
  if (i.updates.length >= MAX_UPDATES) return;
  i.updates = [...i.updates, entry(status, message, false, { userId: null, name: SYSTEM_NAME })];
}

const unresolved = { status: { [Op.ne]: 'RESOLVED' } };

async function lockIncident(id: number, t: Transaction): Promise<Incident> {
  const i = await Incident.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
  if (!i) throw incidentNotFound();
  return i;
}

function realtime(t: Transaction, i: Incident): void {
  emitOps(t, 'platform.incident.changed', { incidentId: i.id!, status: i.status, severity: i.severity });
}

async function notifyOpened(t: Transaction, i: Incident, providerName?: string): Promise<void> {
  notifyAfterCommit(t, 'platform.incident.opened', () => platformUsersWith('platform.dashboard.view'), {
    incidentNo: incidentNo(i.id!),
    title: i.title,
    severity: i.severity,
    components: i.components,
    provider: providerName ?? null,
    link: `/health/incidents/${i.id}`,
  });
}

// ------------------------------------------------------------------ automatic and provider incidents (BR-07-27, 28)
export async function unresolvedIncidentsOfProvider(providerId: number, t: Transaction): Promise<Incident[]> {
  return Incident.findAll({
    where: { serviceProviderId: providerId, ...unresolved },
    order: [['id', 'ASC']],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
}

/** Opens a provider incident (automatic or manual) in the caller's transaction. */
export async function openProviderIncident(
  ctx: Ctx,
  t: Transaction,
  p: ServiceProvider,
  o: {
    severity: IncidentSeverity;
    title: string;
    message: string;
    source: 'PROVIDER_AUTO' | 'PROVIDER_MANUAL';
    isPublic: boolean;
    components: string[];
  },
): Promise<Incident> {
  const by = o.source === 'PROVIDER_AUTO' ? { userId: null, name: SYSTEM_NAME } : actorOf(ctx);
  const i = await Incident.create(
    {
      title: o.title.slice(0, 150),
      severity: o.severity,
      status: 'INVESTIGATING',
      components: o.components,
      serviceProviderId: p.id!,
      source: o.source,
      isPublic: o.isPublic,
      updates: [entry('INVESTIGATING', o.message.slice(0, 1000), o.isPublic, by)],
      startedAt: now(),
      identifiedAt: null,
      monitoringAt: null,
      resolvedAt: null,
      durationMinutes: null,
      rootCause: null,
      version: 1,
      createdBy: by.userId,
      updatedBy: null,
    },
    { transaction: t },
  );
  await audit(
    ctx,
    {
      action: AUDIT.incidentCreated,
      entityType: ENTITY.incident,
      entityId: i.id!,
      entityLabel: i.title,
      after: { severity: i.severity, source: i.source, providerId: p.id },
    },
    t,
  );
  realtime(t, i);
  invalidateStatusAfterCommit(t);
  await notifyOpened(t, i, p.displayName);
  return i;
}

/** Marks an incident RESOLVED in the caller's transaction (shared by the route and BR-07-28). */
export async function resolveIncidentRow(
  ctx: Ctx,
  t: Transaction,
  i: Incident,
  o: {
    message: string;
    rootCause: string | null;
    by: { userId: number | null; name: string };
    skipProviderReset?: boolean;
  },
): Promise<void> {
  const at = now();
  const before = i.status;
  if (i.updates.length < MAX_UPDATES)
    i.updates = [...i.updates, entry('RESOLVED', o.message, i.isPublic, o.by)];
  await i.update(
    {
      status: 'RESOLVED',
      resolvedAt: at,
      durationMinutes: Math.max(0, Math.ceil((at.getTime() - i.startedAt.getTime()) / 60_000)),
      rootCause: o.rootCause,
      updates: i.updates,
      version: i.version + 1,
      updatedBy: o.by.userId,
    },
    { transaction: t },
  );
  await audit(
    ctx,
    {
      action: AUDIT.incidentResolved,
      entityType: ENTITY.incident,
      entityId: i.id!,
      entityLabel: i.title,
      before: { status: before },
      after: { status: 'RESOLVED', durationMinutes: i.durationMinutes },
    },
    t,
  );
  await expireIncidentAnnouncements(ctx, i.id!, t);
  if (!o.skipProviderReset && i.serviceProviderId) {
    // BR-07-29: the last unresolved incident of a MANUAL provider hands control back to the checks
    const left = await Incident.count({
      where: { serviceProviderId: i.serviceProviderId, ...unresolved },
      transaction: t,
    });
    if (left === 0) {
      const p = await ServiceProvider.findByPk(i.serviceProviderId, { transaction: t, lock: t.LOCK.UPDATE });
      if (p && p.statusMode === 'MANUAL')
        await p.update(
          {
            statusMode: 'AUTOMATIC',
            healthStatus: 'OPERATIONAL',
            statusReason: null,
            statusChangedAt: at,
            version: p.version + 1,
          },
          { transaction: t },
        );
    }
  }
  realtime(t, i);
  invalidateStatusAfterCommit(t);
}

// ------------------------------------------------------------------ list and get
export async function listIncidents(q: {
  status?: string[];
  severity?: string[];
  serviceProviderId?: number;
  from?: string;
  to?: string;
  sortBy: 'startedAt' | 'severity';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}) {
  const where: Record<string | symbol, unknown> = {};
  if (q.status) where.status = { [Op.in]: q.status };
  if (q.severity) where.severity = { [Op.in]: q.severity };
  if (q.serviceProviderId) where.serviceProviderId = q.serviceProviderId;
  if (q.from || q.to)
    where.startedAt = {
      ...(q.from ? { [Op.gte]: new Date(`${q.from}T00:00:00.000Z`) } : {}),
      ...(q.to ? { [Op.lt]: addDays(new Date(`${q.to}T00:00:00.000Z`), 1) } : {}),
    };
  const { rows, count } = await Incident.findAndCountAll({
    where: where as WhereOptions,
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const links = rows.length
    ? await PlatformNotification.findAll({
        where: { incidentId: { [Op.in]: rows.map(r => r.id!) } },
        attributes: ['id', 'incidentId'],
      })
    : [];
  const byIncident = new Map(links.map(l => [l.incidentId!, l.id!]));
  const data = await Promise.all(rows.map(r => incidentView(r, byIncident.get(r.id!) ?? null)));
  return { data, pagination: pageMeta(q.page, q.limit, count) };
}

export async function getIncident(id: number) {
  const i = await Incident.findByPk(id);
  if (!i) throw incidentNotFound();
  return incidentView(i);
}

// ------------------------------------------------------------------ create, edit
const notifyRule = () =>
  new UnprocessableError(
    'NOTIFY_REQUIRES_PUBLIC_SEV1_SEV2',
    'Only a public SEV1 or SEV2 incident can notify societies',
  );

export interface CreateIncidentInput {
  title: string;
  severity: IncidentSeverity;
  components: string[];
  serviceProviderId?: number;
  isPublic?: boolean;
  startedAt?: Date;
  message: string;
  notifySocieties?: boolean;
}

export async function createIncident(ctx: Ctx, input: CreateIncidentInput) {
  const isPublic = input.isPublic ?? true;
  const at = now();
  const started = input.startedAt ?? at;
  if (started > at || started < addDays(at, -7))
    throw new ValidationError([
      { field: 'startedAt', message: 'Must be within the last 7 days and not in the future' },
    ]);
  if (input.notifySocieties && !(isPublic && ['SEV1', 'SEV2'].includes(input.severity))) throw notifyRule();
  let provider: ServiceProvider | null = null;
  if (input.serviceProviderId) {
    provider = await ServiceProvider.findByPk(input.serviceProviderId);
    if (!provider) throw providerNotFound();
  }
  const by = actorOf(ctx);
  const id = await sequelize.transaction(async t => {
    const i = await Incident.create(
      {
        title: input.title,
        severity: input.severity,
        status: 'INVESTIGATING',
        components: input.components,
        serviceProviderId: provider?.id ?? null,
        source: 'MANUAL',
        isPublic,
        updates: [entry('INVESTIGATING', input.message, isPublic, by)],
        startedAt: started,
        identifiedAt: null,
        monitoringAt: null,
        resolvedAt: null,
        durationMinutes: null,
        rootCause: null,
        version: 1,
        createdBy: by.userId,
        updatedBy: null,
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.incidentCreated,
        entityType: ENTITY.incident,
        entityId: i.id!,
        entityLabel: i.title,
        after: { severity: i.severity, components: i.components, isPublic, providerId: provider?.id ?? null },
      },
      t,
    );
    if (input.notifySocieties) await createIncidentAnnouncement(ctx, i, t, input.message);
    realtime(t, i);
    invalidateStatusAfterCommit(t);
    await notifyOpened(t, i, provider?.displayName);
    return i.id!;
  });
  return getIncident(id);
}

export async function updateIncident(
  ctx: Ctx,
  id: number,
  patch: {
    version: number;
    title?: string;
    severity?: IncidentSeverity;
    components?: string[];
    isPublic?: boolean;
    notifySocieties?: boolean;
  },
) {
  await sequelize.transaction(async t => {
    const i = await lockIncident(id, t);
    if (i.version !== patch.version) throw staleVersion('incident');
    if (i.status === 'RESOLVED') throw invalidState('A resolved incident cannot be edited');
    const next = {
      title: patch.title ?? i.title,
      severity: patch.severity ?? i.severity,
      components: patch.components ?? i.components,
      isPublic: patch.isPublic ?? i.isPublic,
    };
    if (patch.notifySocieties && !(next.isPublic && ['SEV1', 'SEV2'].includes(next.severity)))
      throw notifyRule();
    const before = { title: i.title, severity: i.severity, components: i.components, isPublic: i.isPublic };
    await i.update({ ...next, version: i.version + 1, updatedBy: ctx.user?.id ?? null }, { transaction: t });
    if (patch.notifySocieties) {
      const exists = await PlatformNotification.count({ where: { incidentId: i.id! }, transaction: t });
      if (!exists)
        await createIncidentAnnouncement(ctx, i, t, i.updates.find(u => u.isPublic)?.message ?? i.title);
    }
    await audit(
      ctx,
      {
        action: AUDIT.incidentUpdated,
        entityType: ENTITY.incident,
        entityId: i.id!,
        entityLabel: i.title,
        before,
        after: next,
      },
      t,
    );
    realtime(t, i);
    invalidateStatusAfterCommit(t);
  });
  return getIncident(id);
}

// ------------------------------------------------------------------ updates and resolve (6.2)
const NEXT: Record<string, IncidentStatus[]> = {
  INVESTIGATING: ['IDENTIFIED', 'MONITORING'],
  IDENTIFIED: ['MONITORING', 'INVESTIGATING'],
  MONITORING: ['INVESTIGATING'],
};

export async function postIncidentUpdate(
  ctx: Ctx,
  id: number,
  input: { version: number; status?: IncidentStatus; message: string; isPublic?: boolean },
) {
  await sequelize.transaction(async t => {
    const i = await lockIncident(id, t);
    if (i.version !== input.version) throw staleVersion('incident');
    if (i.status === 'RESOLVED') throw invalidState('This incident is resolved');
    if (i.updates.length >= MAX_UPDATES)
      throw new UnprocessableError('INCIDENT_UPDATES_LIMIT', 'An incident holds at most 100 updates');
    const to = input.status ?? i.status;
    if (to !== i.status && !NEXT[i.status]?.includes(to))
      throw invalidState(`An incident cannot go from ${i.status} to ${to}`);
    const at = now();
    const patch: Partial<Incident> = {
      status: to,
      updates: [...i.updates, entry(to, input.message, input.isPublic ?? i.isPublic, actorOf(ctx))],
      version: i.version + 1,
      updatedBy: ctx.user?.id ?? null,
    };
    if (to === 'IDENTIFIED' && !i.identifiedAt) patch.identifiedAt = at;
    if (to === 'MONITORING' && !i.monitoringAt) patch.monitoringAt = at;
    const from = i.status;
    await i.update(patch, { transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.incidentUpdatePosted,
        entityType: ENTITY.incident,
        entityId: i.id!,
        entityLabel: i.title,
        before: { status: from },
        after: { status: to },
      },
      t,
    );
    realtime(t, i);
    invalidateStatusAfterCommit(t);
  });
  return getIncident(id);
}

export async function resolveIncident(
  ctx: Ctx,
  id: number,
  input: { version: number; message: string; rootCause?: string },
) {
  await sequelize.transaction(async t => {
    const i = await lockIncident(id, t);
    if (i.version !== input.version) throw staleVersion('incident');
    if (i.status === 'RESOLVED') throw invalidState('This incident is already resolved');
    const rootCause = input.rootCause?.trim() ? input.rootCause.trim() : null;
    if (['SEV1', 'SEV2'].includes(i.severity) && (!rootCause || rootCause.length < 20))
      throw new UnprocessableError(
        'ROOT_CAUSE_REQUIRED',
        'Describe the root cause (at least 20 characters) to resolve a SEV1 or SEV2 incident',
      );
    if (i.updates.length >= MAX_UPDATES)
      throw new UnprocessableError('INCIDENT_UPDATES_LIMIT', 'An incident holds at most 100 updates');
    await resolveIncidentRow(ctx, t, i, { message: input.message, rootCause, by: actorOf(ctx) });
  });
  return getIncident(id);
}

// ------------------------------------------------------------------ provider recovery (BR-07-27)
/** Automatic status returned to OPERATIONAL: the system update, and INVESTIGATING or IDENTIFIED moves to MONITORING. */
export async function autoIncidentRecovered(t: Transaction, providerId: number): Promise<void> {
  const open = await Incident.findAll({
    where: { serviceProviderId: providerId, source: 'PROVIDER_AUTO', ...unresolved },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  for (const i of open) {
    appendSystemUpdate(i, 'MONITORING', 'Provider checks are passing again');
    const patch: Partial<Incident> = { updates: i.updates, version: i.version + 1 };
    if (i.status === 'INVESTIGATING' || i.status === 'IDENTIFIED') {
      patch.status = 'MONITORING';
      if (!i.monitoringAt) patch.monitoringAt = now();
    }
    await i.update(patch, { transaction: t });
    realtime(t, i);
  }
  if (open.length) invalidateStatusAfterCommit(t);
}

/** DEGRADED to OUTAGE raises an open automatic SEV3 incident to SEV2. Returns true when an incident exists. */
export async function raiseAutoIncident(
  t: Transaction,
  providerId: number,
  reason: string,
): Promise<boolean> {
  const open = await Incident.findAll({
    where: { serviceProviderId: providerId, source: 'PROVIDER_AUTO', ...unresolved },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  for (const i of open) {
    if (i.severity !== 'SEV3') continue;
    appendSystemUpdate(i, i.status, `Checks keep failing: ${reason}. Raised to SEV2.`);
    await i.update({ severity: 'SEV2', updates: i.updates, version: i.version + 1 }, { transaction: t });
    realtime(t, i);
  }
  if (open.length) invalidateStatusAfterCommit(t);
  return open.length > 0;
}
