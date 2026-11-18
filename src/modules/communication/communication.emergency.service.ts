import { Op, UniqueConstraintError, type Transaction } from 'sequelize';
import { jobCtx } from './communication.jobs.common';
import { Building, EmergencyBroadcast, EmergencyResponse, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, UnprocessableError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { normaliseAudience, resolveAudience } from './communication.audience';
import {
  AUDIT,
  ENTITY,
  ERR,
  NOTIFY,
  PERM,
  RT,
  roomAdmin,
  roomGate,
  type EmergencyType,
  type ResponseChannel,
  type ResponseStatus,
} from './communication.constants';
import { notify } from './communication.core';
import { communicationPorts } from './communication.ports';
import { assertCanCancelEmergency, assertCanRealert, assertEmergencyTransition } from './communication.state';
import {
  DEFAULT_TITLES,
  audienceOf,
  eNotFound,
  emergencyLink,
  emitEmergency,
  fullRecipients,
  latestResponses,
  occupiedAudienceUnits,
  recipientsOf,
  sendEmergency,
  societyIdOf,
} from './communication.emergency.shared';
import { emitToRoom } from '../../lib/realtime';
import { members, usersWithPermission } from '../access-control/access-control.public';
import { residents } from '../residents/residents.public';
import { units } from '../society-setup/society-setup.public';
import { getBroadcastDetail, type BroadcastDetail } from './communication.emergency.read';

/** Emergency broadcasts, write side (8.25, 8.28, 8.29, BR-16-37 to BR-16-43). Notifications and realtime go out after commit. */

export interface StartInput {
  type: EmergencyType;
  title?: string;
  message: string;
  audience?: { type: 'ALL' } | { type: 'BUILDINGS'; ids: number[] };
  includeStaff?: boolean;
  collectResponses?: boolean;
  isDrill?: boolean;
  sosAlertId?: number | null;
}

const stale = () =>
  new AppError(409, ERR.staleVersion, 'The broadcast was changed by someone else. Reload and try again.');

async function lock(societyId: number, id: number, t: Transaction): Promise<EmergencyBroadcast> {
  const b = await EmergencyBroadcast.findOne({
    where: { id, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!b) throw eNotFound();
  return b;
}
const checkVersion = (b: EmergencyBroadcast, version: number | undefined) => {
  if (version !== undefined && b.version !== version) throw stale();
};

// ------------------------------------------------------------------ start (8.25)
export async function startBroadcast(ctx: Ctx, input: StartInput): Promise<EmergencyBroadcast> {
  const societyId = societyIdOf(ctx);
  if (!ctx.user)
    throw new ValidationError([{ field: 'user', message: 'A signed-in user starts a broadcast' }]);
  const isDrill = Boolean(input.isDrill);
  const status = ctx.society?.status;
  if (status === 'CLOSED') throw new AppError(423, ERR.societyClosed, 'This society is closed');
  if (status === 'SUSPENDED' && isDrill)
    throw new AppError(423, ERR.societySuspended, 'Drills are blocked while the society is suspended');

  const aud = normaliseAudience(input.audience ?? { type: 'ALL' }, {
    allowRoles: false,
    errorCode: ERR.emergencyAudienceInvalid,
  });
  if (aud.type !== 'ALL' && aud.type !== 'BUILDINGS')
    throw new UnprocessableError(ERR.emergencyAudienceInvalid, 'Choose all buildings or specific buildings');
  if (aud.type === 'BUILDINGS') {
    const n = await Building.count({ where: { societyId, id: { [Op.in]: aud.ids! }, status: 'ACTIVE' } });
    if (n !== aud.ids!.length)
      throw new UnprocessableError(ERR.emergencyAudienceInvalid, 'Unknown or archived building', [
        { field: 'audience.ids', message: 'Unknown or archived building' },
      ]);
  }
  const type = input.type;
  const includeStaff = input.includeStaff ?? true;
  const draft = {
    audienceType: aud.type,
    audienceBuildingIds: aud.type === 'BUILDINGS' ? aud.ids : null,
    includeStaff,
  };
  const [rec, occupied] = await Promise.all([
    recipientsOf(societyId, draft),
    occupiedAudienceUnits(societyId, audienceOf(draft)),
  ]);
  const at = now();
  const b = await sequelize.transaction(async t => {
    const active = await EmergencyBroadcast.findOne({
      where: { societyId, type, isDrill, status: 'ACTIVE' },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (active) throw alreadyActive(active.id);
    let row: EmergencyBroadcast;
    try {
      row = await EmergencyBroadcast.create(
        {
          societyId,
          type,
          isDrill,
          title: input.title ?? DEFAULT_TITLES[type],
          message: input.message,
          ...draft,
          collectResponses: input.collectResponses ?? true,
          status: 'ACTIVE',
          sosAlertId: input.sosAlertId ?? null,
          startedBy: ctx.user!.id,
          startedAt: at,
          recipientCount: rec.count,
          unitCount: occupied.length,
          createdBy: ctx.user!.id,
          updatedBy: ctx.user!.id,
        },
        { transaction: t },
      );
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        const other = await EmergencyBroadcast.findOne({
          where: { societyId, type, isDrill, status: 'ACTIVE' },
        });
        throw alreadyActive(other?.id ?? 0);
      }
      throw err;
    }
    await audit(
      ctx,
      {
        action: AUDIT.emergencyStarted,
        entityType: ENTITY.emergency,
        entityId: row.id,
        societyId,
        after: {
          type,
          isDrill,
          recipientCount: rec.count,
          unitCount: occupied.length,
          messageLength: input.message.length,
        },
      },
      t,
    );
    return row;
  });
  await sendEmergency(NOTIFY.emergencyAlert, b, fullRecipients(b, rec), { dedupeKey: `emg:${b.id}:start` });
  emitEmergency(b, RT.emergencyStarted, rec.userIds, RT.emergencyAlert);
  return b;
}

const alreadyActive = (id: number) =>
  new AppError(409, ERR.emergencyAlreadyActive, 'A broadcast of this type is already active', [
    { field: 'id', message: String(id) },
  ]);

/** 8.38 `emergency.startFromSos` (module 17): idempotent on `sosAlertId`; an active alert of the same type is returned with `created: false`. */
export async function startFromSos(
  ctx: Ctx,
  input: { sosAlertId: number; type: EmergencyType; message: string; buildingIds?: number[] },
): Promise<{ broadcastId: number; created: boolean }> {
  const societyId = societyIdOf(ctx);
  const same = await EmergencyBroadcast.findOne({ where: { societyId, sosAlertId: input.sosAlertId } });
  if (same) return { broadcastId: same.id, created: false };
  try {
    const b = await startBroadcast(ctx, {
      type: input.type,
      message:
        input.message.length < 8 ? `${input.message} (SOS)`.slice(0, 500) : input.message.slice(0, 500),
      audience: input.buildingIds?.length ? { type: 'BUILDINGS', ids: input.buildingIds } : { type: 'ALL' },
      includeStaff: true,
      isDrill: false,
      sosAlertId: input.sosAlertId,
    });
    return { broadcastId: b.id, created: true };
  } catch (err) {
    if (err instanceof AppError && err.code === ERR.emergencyAlreadyActive) {
      const id = Number(err.errors?.[0]?.message);
      if (id) return { broadcastId: id, created: false };
    }
    throw err;
  }
}

// ------------------------------------------------------------------ update, realert, resolve, cancel (8.28)
type Action = 'update' | 'realert' | 'resolve' | 'cancel';

async function act<T>(
  ctx: Ctx,
  id: number,
  version: number,
  action: Action,
  mutate: (b: EmergencyBroadcast, at: Date) => { audit: Record<string, unknown>; action: string } & T,
): Promise<{ b: EmergencyBroadcast; extra: T }> {
  const societyId = societyIdOf(ctx);
  return sequelize.transaction(async t => {
    const b = await lock(societyId, id, t);
    assertEmergencyTransition(b.status, action);
    checkVersion(b, version);
    const at = now();
    const m = mutate(b, at);
    b.version += 1;
    b.updatedBy = ctx.user?.id ?? null;
    await b.save({ transaction: t });
    await audit(
      ctx,
      { action: m.action, entityType: ENTITY.emergency, entityId: b.id, societyId, after: m.audit },
      t,
    );
    return { b, extra: m as unknown as T };
  });
}

export async function sendUpdate(
  ctx: Ctx,
  id: number,
  body: { version: number; message: string },
): Promise<BroadcastDetail> {
  const { b } = await act(ctx, id, body.version, 'update', (row, at) => {
    row.updateCount += 1;
    row.lastUpdateMessage = body.message;
    row.lastUpdateAt = at;
    // 9: the update text is kept in the audit row (8.26 reads "updates" from it); only ids and the text of this one update.
    return { action: AUDIT.emergencyUpdated, audit: { updateNo: row.updateCount, message: body.message } };
  });
  const rec = await recipientsOf(b.societyId, b);
  await sendEmergency(NOTIFY.emergencyUpdate, b, fullRecipients(b, rec), {
    dedupeKey: `emg:${b.id}:upd:${b.updateCount}`,
    message: body.message,
  });
  emitEmergency(b, RT.emergencyUpdated, rec.userIds, RT.emergencyUpdated);
  return getBroadcastDetail(ctx, b.id);
}

export async function realert(ctx: Ctx, id: number, body: { version: number }): Promise<BroadcastDetail> {
  const { b } = await act(ctx, id, body.version, 'realert', (row, at) => {
    assertCanRealert(row.lastRealertAt, at);
    row.realertCount += 1;
    row.lastRealertAt = at;
    return { action: AUDIT.emergencyRealerted, audit: { realertNo: row.realertCount } };
  });
  // users of units without a latest response (BR-16-42)
  const societyId = b.societyId;
  const answered = new Set((await latestResponses(b.id)).map(r => r.unitId).filter((x): x is number => !!x));
  const r = await resolveAudience(societyId, audienceOf(b));
  const waiting = r.people.filter(p => p.unitId && !answered.has(p.unitId));
  const userIds = [...new Set(waiting.filter(p => p.userId).map(p => p.userId!))];
  const mobiles = [
    ...new Set(
      waiting.filter(p => !p.userId && p.mobile && /^[6-9]\d{9}$/.test(p.mobile)).map(p => p.mobile!),
    ),
  ];
  await sendEmergency(NOTIFY.emergencyRealert, b, [...userIds, ...mobiles.map(mobile => ({ mobile }))], {
    channels: ['PUSH', 'SMS'],
    dedupeKey: `emg:${b.id}:realert:${b.realertCount}`,
  });
  emitEmergency(b, RT.emergencyUpdated, userIds, RT.emergencyAlert);
  return getBroadcastDetail(ctx, b.id);
}

async function finish(
  ctx: Ctx,
  b: EmergencyBroadcast,
  key: string,
  dedupeKey: string,
  message: string,
): Promise<void> {
  const rec = await recipientsOf(b.societyId, b);
  await sendEmergency(key, b, fullRecipients(b, rec), {
    channels: ['IN_APP', 'PUSH', 'SMS'],
    dedupeKey,
    message,
  });
  emitEmergency(b, RT.emergencyEnded, rec.userIds, RT.emergencyEnded);
}

export async function resolve(
  ctx: Ctx,
  id: number,
  body: { version: number; allClearMessage: string },
): Promise<BroadcastDetail> {
  const { b } = await act(ctx, id, body.version, 'resolve', (row, at) => {
    row.status = assertEmergencyTransition(row.status, 'resolve');
    row.resolvedBy = ctx.user?.id ?? null;
    row.resolvedAt = at;
    row.allClearMessage = body.allClearMessage;
    return { action: AUDIT.emergencyResolved, audit: { allClearLength: body.allClearMessage.length } };
  });
  await finish(ctx, b, NOTIFY.emergencyAllClear, `emg:${b.id}:resolved`, body.allClearMessage);
  return getBroadcastDetail(ctx, b.id);
}

export async function cancel(
  ctx: Ctx,
  id: number,
  body: { version: number; reason: string },
): Promise<BroadcastDetail> {
  const { b } = await act(ctx, id, body.version, 'cancel', (row, at) => {
    assertCanCancelEmergency(row.startedAt, at);
    row.status = assertEmergencyTransition(row.status, 'cancel');
    row.cancelledBy = ctx.user?.id ?? null;
    row.cancelledAt = at;
    row.cancelReason = body.reason;
    return { action: AUDIT.emergencyCancelled, audit: { reasonLength: body.reason.length } };
  });
  await finish(ctx, b, NOTIFY.emergencyCancelled, `emg:${b.id}:cancelled`, body.reason);
  return getBroadcastDetail(ctx, b.id);
}

// ------------------------------------------------------------------ responses (8.29)
export interface ResponseInput {
  status: ResponseStatus;
  peopleCount?: number;
  note?: string;
  unitId?: number;
  channel?: 'APP' | 'PUSH_ACTION' | 'WHATSAPP';
}
const needUnit = (message: string) =>
  new UnprocessableError(ERR.emergencyUnitRequired, message, [{ field: 'unitId', message }]);

export async function recordResponse(
  ctx: Ctx,
  broadcastId: number,
  body: ResponseInput,
  via: 'APP' | 'GATE',
): Promise<{
  responseId: number;
  status: ResponseStatus;
  peopleCount: number;
  respondedAt: Date;
  counts: { safe: number; needHelp: number };
}> {
  const societyId = societyIdOf(ctx);
  const userId = ctx.user!.id;
  const pre = await EmergencyBroadcast.findOne({ where: { id: broadcastId, societyId } });
  if (!pre) throw eNotFound();
  const audUnits = new Set((await occupiedAudienceUnits(societyId, audienceOf(pre))).map(u => u.id));
  const isAdmin = Boolean(ctx.permissions?.has(PERM.emergencyCreate));
  const staffRecipient =
    pre.includeStaff && (ctx.membership?.roleScope === 'society' || ctx.membership?.roleScope === 'gate');

  let channel: ResponseChannel;
  let unitId: number | null = null;
  let subjectKey: string;
  let about: number | null;
  if (via === 'GATE') {
    if (!body.unitId || !audUnits.has(body.unitId)) throw needUnit('Choose a flat in the alert audience');
    unitId = body.unitId;
    subjectKey = `u:${unitId}`;
    channel = 'GATE';
    about = null;
  } else if (isAdmin && body.unitId !== undefined) {
    if (!audUnits.has(body.unitId)) throw needUnit('Choose a flat in the alert audience');
    unitId = body.unitId;
    subjectKey = `u:${unitId}`;
    channel = 'ADMIN';
    about = null;
  } else {
    const mine = (ctx.unitIds ?? []).filter(u => audUnits.has(u));
    if (body.unitId !== undefined) {
      if (!mine.includes(body.unitId)) throw needUnit('Choose one of your flats in the alert audience');
      unitId = body.unitId;
    } else if (mine.length === 1) unitId = mine[0]!;
    else if (mine.length > 1) throw needUnit('Choose the flat you are answering for');
    else if (!staffRecipient) throw eNotFound();
    subjectKey = unitId ? `u:${unitId}` : `p:${userId}`;
    channel = body.channel ?? 'APP';
    about = userId;
  }
  const note = body.note?.trim() || null;
  if (body.status === 'NEED_HELP' && (channel === 'GATE' || channel === 'ADMIN') && (note ?? '').length < 5)
    throw new ValidationError([{ field: 'note', message: 'Add a note of at least 5 characters' }]);

  const result = await sequelize.transaction(async t => {
    const b = await lock(societyId, broadcastId, t);
    assertEmergencyTransition(b.status, 'response');
    if (!b.collectResponses)
      throw new UnprocessableError(ERR.emergencyResponsesDisabled, 'This alert does not collect responses');
    await EmergencyResponse.update(
      { isLatest: false },
      { where: { broadcastId, subjectKey, isLatest: true }, transaction: t },
    );
    const row = await EmergencyResponse.create(
      {
        societyId,
        broadcastId,
        subjectKey,
        unitId,
        userId: about,
        recordedBy: userId,
        status: body.status,
        peopleCount: body.peopleCount ?? 1,
        note,
        channel,
        isLatest: true,
        createdBy: userId,
        updatedBy: null,
      },
      { transaction: t },
    );
    const [safe, help] = await Promise.all(
      (['SAFE', 'NEED_HELP'] as const).map(s =>
        EmergencyResponse.count({ where: { broadcastId, isLatest: true, status: s }, transaction: t }),
      ),
    );
    b.safeCount = safe!;
    b.helpCount = help!;
    await b.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.responseRecorded,
        entityType: ENTITY.emergencyResponse,
        entityId: row.id,
        societyId,
        after: {
          broadcastId,
          subjectKey,
          status: body.status,
          peopleCount: row.peopleCount,
          channel,
          note: note ? note.slice(0, 50) : null,
        },
      },
      t,
    );
    return { b, row };
  });
  const { b, row } = result;
  emitToRoom(roomAdmin(societyId), RT.emergencyResponse, {
    broadcastId,
    responseId: row.id,
    status: row.status,
    safeCount: b.safeCount,
    helpCount: b.helpCount,
  });
  emitToRoom(roomGate(societyId), RT.emergencyResponse, {
    broadcastId,
    responseId: row.id,
    status: row.status,
    safeCount: b.safeCount,
    helpCount: b.helpCount,
  });
  if (body.status === 'NEED_HELP') {
    const unitLabel = unitId
      ? ((await units.listActive(societyId, { unitIds: [unitId] }))[0]?.label ?? `Flat ${unitId}`)
      : (ctx.user?.name ?? 'Staff');
    const targets = new Set<number>([
      b.startedBy,
      ...(await usersWithPermission(societyId, PERM.emergencyCreate)),
      ...(await guardUserIds(societyId)),
    ]);
    try {
      await notify(
        NOTIFY.emergencyHelpRequested,
        [...targets],
        {
          broadcastId,
          unitLabel,
          people: row.peopleCount,
          prefix: b.isDrill ? 'DRILL: ' : '',
          link: emergencyLink(broadcastId),
        },
        {
          societyId,
          channels: b.isDrill ? ['IN_APP', 'PUSH'] : undefined,
          dedupeKey: `emg-help:${row.id}`,
          sourceType: 'emergency_broadcast',
          sourceId: broadcastId,
        },
      );
    } catch {
      /* logged by the core; the response is saved */
    }
  }
  return {
    responseId: row.id,
    status: row.status,
    peopleCount: row.peopleCount,
    respondedAt: row.createdAt,
    counts: { safe: b.safeCount, needHelp: b.helpCount },
  };
}

async function guardUserIds(societyId: number): Promise<number[]> {
  const onDuty = await communicationPorts().guards.onDutyGuardUserIds(societyId);
  if (onDuty.length) return onDuty;
  return (await members.listForSociety(societyId, { roleScope: 'gate', statuses: ['ACTIVE'] })).map(
    m => m.userId,
  );
}

export async function attendResponse(
  ctx: Ctx,
  broadcastId: number,
  responseId: number,
  body: { note?: string },
): Promise<{ responseId: number; attendedAt: Date }> {
  const societyId = societyIdOf(ctx);
  const { b, row } = await sequelize.transaction(async t => {
    const b = await lock(societyId, broadcastId, t);
    assertEmergencyTransition(b.status, 'attend');
    const row = await EmergencyResponse.findOne({
      where: { id: responseId, broadcastId, societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!row) throw eNotFound();
    if (row.status !== 'NEED_HELP' || !row.isLatest || row.attendedBy)
      throw new AppError(409, ERR.invalidState, 'This help request cannot be marked attended');
    row.attendedBy = ctx.user!.id;
    row.attendedAt = now();
    row.updatedBy = ctx.user!.id;
    await row.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.responseAttended,
        entityType: ENTITY.emergencyResponse,
        entityId: row.id,
        societyId,
        after: { broadcastId, noteLength: body.note?.length ?? 0 },
      },
      t,
    );
    return { b, row };
  });
  emitToRoom(roomAdmin(societyId), RT.emergencyResponse, { broadcastId, responseId, attended: true });
  emitToRoom(roomGate(societyId), RT.emergencyResponse, { broadcastId, responseId, attended: true });
  const responder = row.userId ?? row.recordedBy;
  const unitIds = row.unitId ? [row.unitId] : [];
  const targets = new Set<number>([responder]);
  if (unitIds.length)
    for (const l of await residents.listForUnit(societyId, unitIds[0]!)) if (l.userId) targets.add(l.userId);
  try {
    await notify(
      NOTIFY.emergencyHelpOnWay,
      [...targets],
      { broadcastId, prefix: b.isDrill ? 'DRILL: ' : '' },
      {
        societyId,
        dedupeKey: `emg-attend:${row.id}`,
        sourceType: 'emergency_broadcast',
        sourceId: broadcastId,
      },
    );
  } catch {
    /* logged by the core */
  }
  return { responseId: row.id, attendedAt: row.attendedAt! };
}

/** Hook `recordEmergencyResponse` of 16.4's webhook job: a WhatsApp button reply recorded as the user for one flat. */
export async function recordWhatsappResponse(input: {
  societyId: number;
  broadcastId: number;
  userId: number;
  unitId: number;
  status: 'SAFE' | 'NEED_HELP';
  channel: 'WHATSAPP';
}): Promise<void> {
  const ctx = {
    ...jobCtx(input.societyId, 'whatsapp-reply'),
    user: { id: input.userId },
    unitIds: [input.unitId],
    permissions: new Set<string>(),
  } as unknown as Ctx;
  await recordResponse(
    ctx,
    input.broadcastId,
    { status: input.status, unitId: input.unitId, channel: input.channel },
    'APP',
  );
}
