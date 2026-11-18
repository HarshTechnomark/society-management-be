import { Op } from 'sequelize';
import { Building, Unit, User } from '../../models';
import type { Notice } from '../../models';
import { publicStatus } from '../approvals/approvals.public';
import type { Ctx, SystemCtx } from '../../types/context';
import { audienceLabel } from './communication.audience';
import { actionLabel, actionTarget } from './communication.composer';
import { communicationPorts } from './communication.ports';
import type { NoticeActionInput } from './communication.types';
import { n, noticeNumber, societyIdOf } from './communication.notices.shared';

/** `NoticeDto` (8.1 list item, 8.5 detail). Dates are ISO strings. */
const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

export async function namesOf(ids: (number | null)[]): Promise<Map<number, string>> {
  const u = [...new Set(ids.filter((x): x is number => !!x))];
  if (!u.length) return new Map();
  const rows = await User.findAll({ where: { id: { [Op.in]: u } }, attributes: ['id', 'name'] });
  return new Map(rows.map(r => [n(r.id), r.name ?? 'User']));
}
const person = (id: number | null, names: Map<number, string>) =>
  id ? { id, name: names.get(id) ?? 'User' } : null;

/** Human label of an audience: building names or flat labels (first 3), else the generic label. */
export async function labelOf(
  societyId: number,
  a: {
    audienceType: string;
    audienceRelation: string;
    audienceIds: number[] | null;
    audienceRoleKeys: string[] | null;
  },
): Promise<string> {
  const generic = audienceLabel({
    type: a.audienceType as never,
    relation: a.audienceRelation as never,
    ids: a.audienceIds ?? undefined,
    roleKeys: a.audienceRoleKeys ?? undefined,
  });
  const ids = a.audienceIds ?? [];
  const suffix =
    a.audienceRelation === 'OWNERS' ? ' (owners)' : a.audienceRelation === 'TENANTS' ? ' (tenants)' : '';
  const list = (names: string[]) =>
    names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
  if (a.audienceType === 'BUILDINGS' && ids.length) {
    const rows = await Building.findAll({
      where: { societyId, id: { [Op.in]: ids } },
      attributes: ['id', 'name', 'code'],
      order: [['code', 'ASC']],
    });
    if (rows.length) return list(rows.map(r => r.name || r.code)) + suffix;
  }
  if (a.audienceType === 'UNITS' && ids.length) {
    const rows = await Unit.findAll({
      where: { societyId, id: { [Op.in]: ids } },
      attributes: ['id', 'label'],
      order: [['label', 'ASC']],
    });
    if (rows.length) return list(rows.map(r => r.label)) + suffix;
  }
  if (a.audienceType === 'ROLES') return generic;
  return generic;
}

const excerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
};

export interface ListItem {
  id: number;
  number: string;
  kind: string;
  category: string;
  priority: string;
  title: string;
  excerpt: string;
  status: string;
  isPinned: boolean;
  requiresAck: boolean;
  audienceLabel: string;
  actions: { type: string; label: string }[];
  publishedAt: string | null;
  scheduledAt: string | null;
  recipientCount: number;
  readCount: number;
  ackCount: number;
  author: { id: number; name: string } | null;
  version: number;
}

export async function toListItems(ctx: Ctx | SystemCtx, rows: Notice[]): Promise<ListItem[]> {
  const societyId = societyIdOf(ctx);
  const names = await namesOf(rows.map(r => r.createdBy));
  const labels = new Map<number, string>();
  for (const r of rows) labels.set(n(r.id), await labelOf(societyId, r));
  return rows.map(r => ({
    id: n(r.id),
    number: noticeNumber(n(r.id)),
    kind: r.kind,
    category: r.category,
    priority: r.priority,
    title: r.title,
    excerpt: excerpt(r.bodyText),
    status: r.status,
    isPinned: Boolean(r.isPinned),
    requiresAck: Boolean(r.requiresAck),
    audienceLabel: labels.get(n(r.id))!,
    actions: (r.actions ?? []).map(a => ({ type: a.type, label: actionLabel(a) })),
    publishedAt: iso(r.publishedAt),
    scheduledAt: iso(r.scheduledAt),
    recipientCount: n(r.recipientCount),
    readCount: n(r.readCount),
    ackCount: n(r.ackCount),
    author: person(r.createdBy, names),
    version: n(r.version),
  }));
}

export async function attachmentsOf(societyId: number, noticeId: number) {
  const files = communicationPorts().files;
  const out: { fileId: number; name: string; sizeBytes: number; status: string }[] = [];
  for (const fileId of files.list(noticeId)) {
    const f = await files.describe(societyId, fileId);
    if (f) out.push({ fileId, name: f.name, sizeBytes: f.sizeBytes, status: f.status });
  }
  return out;
}

/** 8.5 detail. */
export async function toDetail(ctx: Ctx | SystemCtx, notice: Notice) {
  const societyId = societyIdOf(ctx);
  const r = notice;
  const names = await namesOf([r.createdBy, r.approvedBy, r.recalledBy, r.publishedBy]);
  const actions: (NoticeActionInput & { label: string; target?: { title?: string; status?: string } })[] = [];
  for (const a of r.actions ?? []) {
    const t =
      r.status === 'DRAFT' ||
      r.status === 'PENDING_APPROVAL' ||
      r.status === 'SCHEDULED' ||
      r.status === 'PUBLISHED'
        ? await actionTarget(societyId, a)
        : { open: false };
    actions.push({
      ...a,
      label: actionLabel(a),
      ...(t.title || t.status ? { target: { title: t.title, status: t.status } } : {}),
    });
  }
  let approval: { requestId: number; status: string; statusLabel: string } | null = null;
  if (r.approvalRequestId) {
    const st = await publicStatus(societyId, 'NOTICE_PUBLISH', n(r.id));
    approval = {
      requestId: n(r.approvalRequestId),
      status: st?.status ?? 'PENDING',
      statusLabel: st?.statusLabel ?? 'Waiting',
    };
  }
  return {
    id: n(r.id),
    number: noticeNumber(n(r.id)),
    kind: r.kind,
    category: r.category,
    priority: r.priority,
    title: r.title,
    body: r.body,
    locale: r.locale,
    status: r.status,
    audience: {
      type: r.audienceType,
      relation: r.audienceRelation,
      ids: r.audienceIds,
      roleKeys: r.audienceRoleKeys,
      label: await labelOf(societyId, r),
    },
    channels: r.channels ?? [],
    actions,
    requiresAck: Boolean(r.requiresAck),
    ackDueAt: iso(r.ackDueAt),
    isPinned: Boolean(r.isPinned),
    scheduledAt: iso(r.scheduledAt),
    expiresAt: iso(r.expiresAt),
    publishedAt: iso(r.publishedAt),
    utility:
      r.kind === 'UTILITY_SHUTDOWN'
        ? {
            type: r.utilityType,
            startsAt: iso(r.outageStartsAt),
            endsAt: iso(r.outageEndsAt),
            restoredAt: iso(r.restoredAt),
          }
        : null,
    attachments: await attachmentsOf(societyId, n(r.id)),
    approval,
    approvedBy: person(r.approvedBy, names),
    approvedAt: iso(r.approvedAt),
    lastDecisionReason: r.lastDecisionReason,
    recalledReason: r.recallReason,
    recalledAt: iso(r.recalledAt),
    revisionNo: n(r.revisionNo),
    lastEditNote: r.lastEditNote,
    recipientCount: n(r.recipientCount),
    unitCount: n(r.unitCount),
    reachedCount: n(r.reachedCount),
    readCount: n(r.readCount),
    ackCount: n(r.ackCount),
    remindersSent: n(r.remindersSent),
    version: n(r.version),
    author: person(r.createdBy, names),
    createdAt: iso(r.createdAt),
  };
}
export type NoticeDetail = Awaited<ReturnType<typeof toDetail>>;
