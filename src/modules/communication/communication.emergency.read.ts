import { Op } from 'sequelize';
import { AuditLog, EmergencyBroadcast, EmergencyResponse } from '../../models';
import { pageMeta, type PageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { residents } from '../residents/residents.public';
import { units } from '../society-setup/society-setup.public';
import { AUDIT, ENTITY, PERM, type ResponseChannel } from './communication.constants';
import { maskMobile } from './communication.crypto';
import {
  audienceOf,
  eNotFound,
  occupiedAudienceUnits,
  societyIdOf,
  startedByNames,
} from './communication.emergency.shared';

/** Emergency broadcasts, read side (8.26, 8.27, 8.30). */

export interface BroadcastDto {
  id: number;
  type: string;
  title: string;
  status: string;
  isDrill: boolean;
  collectResponses: boolean;
  startedAt: Date;
  startedByName: string;
  recipientCount: number;
  unitCount: number;
  safeCount: number;
  helpCount: number;
  updateCount: number;
  lastUpdateMessage: string | null;
  lastUpdateAt: Date | null;
  realertCount: number;
  lastRealertAt: Date | null;
  resolvedAt: Date | null;
  cancelledAt: Date | null;
  version: number;
}

export function toBroadcastDto(b: EmergencyBroadcast, names: Map<number, string>): BroadcastDto {
  return {
    id: b.id,
    type: b.type,
    title: b.title,
    status: b.status,
    isDrill: b.isDrill,
    collectResponses: b.collectResponses,
    startedAt: b.startedAt,
    startedByName: names.get(b.startedBy) ?? 'User',
    recipientCount: b.recipientCount,
    unitCount: b.unitCount,
    safeCount: b.safeCount,
    helpCount: b.helpCount,
    updateCount: b.updateCount,
    lastUpdateMessage: b.lastUpdateMessage,
    lastUpdateAt: b.lastUpdateAt,
    realertCount: b.realertCount,
    lastRealertAt: b.lastRealertAt,
    resolvedAt: b.resolvedAt,
    cancelledAt: b.cancelledAt,
    version: b.version,
  };
}

export interface BroadcastDetail extends BroadcastDto {
  message: string;
  audience: { type: string; ids: number[] };
  includeStaff: boolean;
  allClearMessage: string | null;
  cancelReason: string | null;
  sosAlertId: number | null;
  updates: { message: string; at: Date; byName: string }[];
  counts: { units: number; safe: number; needHelp: number; noResponse: number; peopleSafe: number };
  needHelp: {
    responseId: number;
    unitId: number | null;
    unitLabel: string;
    note: string | null;
    peopleCount: number;
    at: Date;
    attendedBy: string | null;
    attendedAt: Date | null;
  }[];
}

async function loadBroadcast(societyId: number, id: number): Promise<EmergencyBroadcast> {
  const b = await EmergencyBroadcast.findOne({ where: { id, societyId } });
  if (!b) throw eNotFound();
  return b;
}

export async function listBroadcasts(
  ctx: Ctx,
  q: {
    status?: string;
    type?: string;
    isDrill?: boolean;
    from?: string;
    to?: string;
    sortOrder: 'asc' | 'desc';
    page: number;
    limit: number;
  },
): Promise<{ data: BroadcastDto[]; pagination: PageMeta }> {
  const societyId = societyIdOf(ctx);
  const where: Record<string | symbol, unknown> = { societyId };
  if (q.status) where.status = q.status;
  if (q.type) where.type = q.type;
  if (q.isDrill !== undefined) where.isDrill = q.isDrill;
  if (q.from || q.to)
    where.startedAt = {
      ...(q.from ? { [Op.gte]: new Date(`${q.from}T00:00:00+05:30`) } : {}),
      ...(q.to ? { [Op.lt]: new Date(new Date(`${q.to}T00:00:00+05:30`).getTime() + 86_400_000) } : {}),
    };
  const { rows, count } = await EmergencyBroadcast.findAndCountAll({
    where,
    order: [
      ['startedAt', q.sortOrder.toUpperCase()],
      ['id', q.sortOrder.toUpperCase()],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const names = await startedByNames(rows.map(r => r.startedBy));
  return { data: rows.map(r => toBroadcastDto(r, names)), pagination: pageMeta(q.page, q.limit, count) };
}

export async function getBroadcastDetail(ctx: Ctx, id: number): Promise<BroadcastDetail> {
  const societyId = societyIdOf(ctx);
  const b = await loadBroadcast(societyId, id);
  const [latest, auditRows] = await Promise.all([
    EmergencyResponse.findAll({ where: { broadcastId: id, isLatest: true } }),
    AuditLog.findAll({
      where: {
        societyId,
        entityType: ENTITY.emergency,
        entityId: String(id),
        action: AUDIT.emergencyUpdated,
      },
      order: [['id', 'DESC']],
      limit: 50,
    }),
  ]);
  const flat = latest.filter(r => r.unitId);
  const flatSafe = flat.filter(r => r.status === 'SAFE').length;
  const flatHelp = flat.filter(r => r.status === 'NEED_HELP').length;
  const help = latest.filter(r => r.status === 'NEED_HELP');
  const unitLabels = await unitLabelMap(
    societyId,
    help.map(r => r.unitId).filter((x): x is number => !!x),
  );
  const names = await startedByNames([
    b.startedBy,
    ...help.map(r => r.attendedBy),
    ...help.filter(r => !r.unitId).map(r => r.userId),
  ]);
  const base = toBroadcastDto(b, names);
  return {
    ...base,
    message: b.message,
    audience: { type: b.audienceType, ids: b.audienceBuildingIds ?? [] },
    includeStaff: b.includeStaff,
    allClearMessage: b.allClearMessage,
    cancelReason: b.cancelReason,
    sosAlertId: b.sosAlertId,
    updates: auditRows.map(a => ({
      message: String((a.after as { message?: string } | null)?.message ?? ''),
      at: a.createdAt!,
      byName: a.actorName,
    })),
    counts: {
      units: b.unitCount,
      safe: b.safeCount,
      needHelp: b.helpCount,
      noResponse: Math.max(0, b.unitCount - flatSafe - flatHelp),
      peopleSafe: latest.filter(r => r.status === 'SAFE').reduce((s, r) => s + r.peopleCount, 0),
    },
    needHelp: help.map(r => ({
      responseId: r.id,
      unitId: r.unitId,
      unitLabel: r.unitId
        ? (unitLabels.get(r.unitId) ?? `Flat ${r.unitId}`)
        : (names.get(r.userId ?? 0) ?? 'Staff'),
      note: r.note,
      peopleCount: r.peopleCount,
      at: r.createdAt,
      attendedBy: r.attendedBy ? (names.get(r.attendedBy) ?? 'User') : null,
      attendedAt: r.attendedAt,
    })),
  };
}

async function unitLabelMap(societyId: number, ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  return new Map((await units.listActive(societyId, { unitIds: ids })).map(u => [u.id, u.label]));
}

// ------------------------------------------------------------------ roll-call (8.27)
export interface RollCallItem {
  unitId: number;
  unitLabel: string;
  buildingCode: string;
  floor: number;
  status: 'SAFE' | 'NEED_HELP' | 'NO_RESPONSE';
  peopleCount: number | null;
  note: string | null;
  respondedAt: Date | null;
  channel: ResponseChannel | null;
  contacts: { name: string; mobile: string | null }[];
}

export async function rollCall(
  ctx: Ctx,
  id: number,
  q: { status?: string; buildingId?: number; floor?: number; page: number; limit: number },
  o: { gate: boolean },
): Promise<{
  data: RollCallItem[];
  byFloor: { buildingCode: string; floor: number; units: number; safe: number; needHelp: number }[];
  pagination: PageMeta;
}> {
  const societyId = societyIdOf(ctx);
  const b = await loadBroadcast(societyId, id);
  let list = await occupiedAudienceUnits(societyId, audienceOf(b));
  if (q.buildingId) list = list.filter(u => u.buildingId === q.buildingId);
  if (q.floor !== undefined) list = list.filter(u => u.floor === q.floor);
  const latest = await EmergencyResponse.findAll({
    where: { broadcastId: id, isLatest: true, unitId: { [Op.ne]: null } },
  });
  const byUnit = new Map(latest.map(r => [r.unitId!, r]));
  const statusOf = (unitId: number): RollCallItem['status'] => byUnit.get(unitId)?.status ?? 'NO_RESPONSE';

  const floors = new Map<
    string,
    { buildingCode: string; floor: number; units: number; safe: number; needHelp: number }
  >();
  for (const u of list) {
    const k = `${u.buildingCode}|${u.floor}`;
    const f = floors.get(k) ?? {
      buildingCode: u.buildingCode,
      floor: u.floor,
      units: 0,
      safe: 0,
      needHelp: 0,
    };
    f.units += 1;
    const s = statusOf(u.id);
    if (s === 'SAFE') f.safe += 1;
    if (s === 'NEED_HELP') f.needHelp += 1;
    floors.set(k, f);
  }
  const filtered = q.status ? list.filter(u => statusOf(u.id) === q.status) : list;
  const page = filtered.slice((q.page - 1) * q.limit, q.page * q.limit);
  const unmasked = !o.gate && ctx.permissions?.has(PERM.contactsView);
  const data: RollCallItem[] = [];
  for (const u of page) {
    const r = byUnit.get(u.id);
    const links = await residents.listForUnit(societyId, u.id);
    data.push({
      unitId: u.id,
      unitLabel: u.label,
      buildingCode: u.buildingCode,
      floor: u.floor,
      status: statusOf(u.id),
      peopleCount: r?.peopleCount ?? null,
      note: r?.note ?? null,
      respondedAt: r?.createdAt ?? null,
      channel: r?.channel ?? null,
      contacts: links
        .filter(l => l.mobile)
        .map(l => ({ name: l.name, mobile: unmasked ? l.mobile : maskMobile(l.mobile!) })),
    });
  }
  return {
    data,
    byFloor: [...floors.values()].sort(
      (a, c) => a.buildingCode.localeCompare(c.buildingCode) || a.floor - c.floor,
    ),
    pagination: pageMeta(q.page, q.limit, filtered.length),
  };
}

// ------------------------------------------------------------------ active alerts (8.30, 8.38)
export interface ActiveAlert {
  id: number;
  type: string;
  title: string;
  message: string;
  isDrill: boolean;
  startedAt: Date;
  collectResponses: boolean;
  lastUpdateMessage: string | null;
  myUnits: { unitId: number; label: string; response: 'SAFE' | 'NEED_HELP' | null }[];
  myResponse?: 'SAFE' | 'NEED_HELP' | null;
}

/** `me`: broadcasts where the caller is a recipient; `gate`: every active broadcast. */
export async function activeFor(ctx: Ctx, mode: 'me' | 'gate'): Promise<ActiveAlert[]> {
  const societyId = societyIdOf(ctx);
  const rows = await EmergencyBroadcast.findAll({
    where: { societyId, status: 'ACTIVE' },
    order: [['startedAt', 'DESC']],
  });
  const out: ActiveAlert[] = [];
  const staffScope = ctx.membership?.roleScope === 'society' || ctx.membership?.roleScope === 'gate';
  for (const b of rows) {
    const mineUnits: { unitId: number; label: string }[] = [];
    let include = mode === 'gate';
    if (mode === 'me') {
      const aud = await occupiedAudienceUnits(societyId, audienceOf(b));
      const mine = new Set(ctx.unitIds ?? []);
      for (const u of aud) if (mine.has(u.id)) mineUnits.push({ unitId: u.id, label: u.label });
      include = mineUnits.length > 0 || (b.includeStaff && staffScope);
    }
    if (!include) continue;
    const mineResp =
      mode === 'me'
        ? await myResponses(
            b.id,
            mineUnits.map(m => m.unitId),
            ctx.user?.id,
          )
        : null;
    out.push({
      id: b.id,
      type: b.type,
      title: b.title,
      message: b.message,
      isDrill: b.isDrill,
      startedAt: b.startedAt,
      collectResponses: b.collectResponses,
      lastUpdateMessage: b.lastUpdateMessage,
      myUnits: mineUnits.map(m => ({ ...m, response: mineResp?.units.get(m.unitId) ?? null })),
      ...(mode === 'me' ? { myResponse: mineResp?.self ?? null } : {}),
    });
  }
  return out;
}

async function myResponses(broadcastId: number, unitIds: number[], userId: number | undefined) {
  const keys = [...unitIds.map(u => `u:${u}`), ...(userId ? [`p:${userId}`] : [])];
  const rows = keys.length
    ? await EmergencyResponse.findAll({
        where: { broadcastId, isLatest: true, subjectKey: { [Op.in]: keys } },
      })
    : [];
  return {
    units: new Map(rows.filter(r => r.unitId).map(r => [r.unitId!, r.status])),
    self: rows.find(r => !r.unitId)?.status ?? null,
  };
}

/** 8.38 `emergency.getActive`. */
export async function getActiveSummary(
  societyId: number,
): Promise<{ id: number; type: string; title: string; startedAt: Date }[]> {
  const rows = await EmergencyBroadcast.findAll({
    where: { societyId, status: 'ACTIVE' },
    order: [['startedAt', 'DESC']],
  });
  return rows.map(b => ({ id: b.id, type: b.type, title: b.title, startedAt: b.startedAt }));
}
