import { Op, type Transaction } from 'sequelize';
import { Building, Role, Unit } from '../../models';
import { entitlements } from '../subscriptions/subscriptions.public';
import { UnprocessableError, ValidationError } from '../../utils/errors';
import type { Ctx, SystemCtx } from '../../types/context';
import { ENT, ERR, LIMITS, type NoticeCategory, type NoticeExtraChannel } from './communication.constants';
import { normaliseAudience } from './communication.audience';
import { communicationPorts } from './communication.ports';
import { outageValid } from './communication.state';
import type { NoticeActionInput, NoticeAudience } from './communication.types';
import { societyIdOf } from './communication.notices.shared';

/**
 * Composer rules of notices (BR-16-3, BR-16-13, BR-16-14, BR-16-16): audience existence, plan gates, action targets,
 * utility window and attachments. Services call these; they never write status columns.
 */
export interface StoredAudience {
  type: 'ALL' | 'BUILDINGS' | 'UNITS' | 'ROLES';
  relation: 'ANY' | 'OWNERS' | 'TENANTS';
  ids: number[] | null;
  roleKeys: string[] | null;
}

const feature = async (ctx: Ctx | SystemCtx, key: (typeof ENT)[keyof typeof ENT]): Promise<boolean> =>
  entitlements.isFeatureOn(societyIdOf(ctx), key as never);
const needFeature = (ctx: Ctx | SystemCtx, key: (typeof ENT)[keyof typeof ENT]) =>
  entitlements.assertFeature(ctx as Ctx, key as never);

/** BR-16-3: normalises, checks the plan gate and that every building, unit or role exists, is ACTIVE and in the society. */
export async function checkAudience(
  ctx: Ctx | SystemCtx,
  a: NoticeAudience,
  opts: { skipGate?: boolean } = {},
): Promise<StoredAudience> {
  const norm = normaliseAudience(a);
  if (!opts.skipGate && (norm.type !== 'ALL' || norm.relation !== 'ANY'))
    await needFeature(ctx, ENT.audienceTargeting);
  const societyId = societyIdOf(ctx);
  const bad = (field: string, message: string) =>
    new UnprocessableError(ERR.noticeAudienceInvalid, message, [{ field, message }]);
  if (norm.type === 'BUILDINGS') {
    const rows = await Building.findAll({
      where: { societyId, id: { [Op.in]: norm.ids! }, status: 'ACTIVE' },
      attributes: ['id'],
    });
    if (rows.length !== norm.ids!.length)
      throw bad('audience.ids', 'A building does not exist or is archived');
  } else if (norm.type === 'UNITS') {
    const rows = await Unit.findAll({
      where: { societyId, id: { [Op.in]: norm.ids! }, status: 'ACTIVE' },
      attributes: ['id'],
    });
    if (rows.length !== norm.ids!.length) throw bad('audience.ids', 'A flat does not exist or is archived');
  } else if (norm.type === 'ROLES') {
    const rows = await Role.findAll({
      where: { societyId, key: { [Op.in]: norm.roleKeys! }, scope: { [Op.in]: ['society', 'gate'] } },
      attributes: ['key'],
    });
    const have = new Set(rows.map(r => r.key));
    const missing = norm.roleKeys!.filter(k => !have.has(k));
    if (missing.length) throw bad('audience.roleKeys', `Unknown role: ${missing[0]}`);
  }
  return norm;
}

/** BR-16-14: channels are a unique subset of EMAIL, SMS, WHATSAPP; WHATSAPP needs the integration. */
export async function checkChannels(
  ctx: Ctx | SystemCtx,
  channels: NoticeExtraChannel[],
): Promise<NoticeExtraChannel[]> {
  const u = [...new Set(channels)];
  if (u.includes('WHATSAPP')) await needFeature(ctx, ENT.whatsappMessaging);
  return u;
}

/** BR-16-13 shape and plan gate (at most 2, no two of one type). Targets are checked at publish. */
export async function checkActionsShape(
  ctx: Ctx | SystemCtx,
  actions: NoticeActionInput[],
): Promise<NoticeActionInput[]> {
  if (!actions.length) return [];
  await needFeature(ctx, ENT.actionButtons);
  if (actions.length > LIMITS.actionsMax)
    throw new ValidationError([{ field: 'actions', message: `At most ${LIMITS.actionsMax} actions` }]);
  const seen = new Set<string>();
  for (const a of actions) {
    if (seen.has(a.type))
      throw new ValidationError([{ field: 'actions', message: 'One action of each type' }]);
    seen.add(a.type);
  }
  return actions.map(a => {
    const o: NoticeActionInput = { type: a.type };
    if (a.refId !== undefined) o.refId = a.refId;
    if (a.url !== undefined) o.url = a.url;
    if (a.label !== undefined) o.label = a.label;
    return o;
  });
}

/** BR-16-13: is the target of an action open right now? PAY_DUES and LINK have no target. */
export async function actionTarget(
  societyId: number,
  a: NoticeActionInput,
): Promise<{ open: boolean; title?: string; status?: string }> {
  const p = communicationPorts();
  if (a.type === 'PAY_COLLECTION') {
    const c = await p.collections.get(societyId, a.refId ?? 0);
    return c ? { open: c.status === 'PUBLISHED', title: c.title, status: c.status } : { open: false };
  }
  if (a.type === 'RSVP' || a.type === 'VOTE')
    return { open: await p.targets.isOpen(a.type, societyId, a.refId ?? 0) };
  return { open: true };
}

/** 8.8 step 2: every target open at publish, else `422 NOTICE_ACTION_INVALID`. */
export async function assertActionsOpen(
  societyId: number,
  actions: NoticeActionInput[] | null,
): Promise<void> {
  for (const a of actions ?? []) {
    const t = await actionTarget(societyId, a);
    if (!t.open)
      throw new UnprocessableError(ERR.noticeActionInvalid, 'An action target is missing or no longer open', [
        { field: 'actions', message: `${a.type} target is not open` },
      ]);
  }
}

/** Default label of an action button in the detail response. */
export const actionLabel = (a: NoticeActionInput): string =>
  a.label ??
  (a.type === 'PAY_COLLECTION' || a.type === 'PAY_DUES'
    ? 'Pay'
    : a.type === 'RSVP'
      ? 'RSVP'
      : a.type === 'VOTE'
        ? 'Vote'
        : 'Open');

/** BR-16-16 at publish. */
export function assertUtilityWindow(
  n: { kind: string; utilityType: string | null; outageStartsAt: Date | null; outageEndsAt: Date | null },
  at: Date,
): void {
  if (n.kind !== 'UTILITY_SHUTDOWN') return;
  if (
    !n.utilityType ||
    !n.outageStartsAt ||
    !n.outageEndsAt ||
    !outageValid(n.outageStartsAt, n.outageEndsAt, at)
  )
    throw new UnprocessableError(
      ERR.noticeUtilityInvalid,
      'The outage must start in the future and last at most 7 days',
    );
}

/** The plan gate of a utility notice (402). */
export const assertUtilityFeature = (ctx: Ctx | SystemCtx) => needFeature(ctx, ENT.utilityShutdown);
export { feature as featureOn, needFeature };

/** Links attachments: each must exist in the society and not be infected (`422 FILE_NOT_LINKABLE` / `FILE_INFECTED`). Returns names for the audit. */
export async function linkFiles(
  ctx: Ctx | SystemCtx,
  noticeId: number,
  fileIds: number[],
  t: Transaction,
): Promise<void> {
  if (!fileIds.length) return;
  const ports = communicationPorts().files;
  const societyId = societyIdOf(ctx);
  for (const id of fileIds) {
    const f = await ports.describe(societyId, id);
    if (!f)
      throw new UnprocessableError(ERR.fileNotLinkable, 'This file cannot be attached', [
        { field: 'fileIds', message: `File ${id}` },
      ]);
    if (f.status === 'INFECTED')
      throw new UnprocessableError(ERR.fileInfected, 'This file failed the virus scan', [
        { field: 'fileIds', message: `File ${id}` },
      ]);
  }
  await ports.link(ctx as Ctx, fileIds, noticeId, t);
}

export type { NoticeCategory };
