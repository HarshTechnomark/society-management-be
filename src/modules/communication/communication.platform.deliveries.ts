import { Op, type WhereOptions } from 'sequelize';
import { Notification } from '../../models';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { AUDIT, ENTITY } from './communication.constants';
import { emailKey, mobileKey } from './communication.crypto';

/** 8.36 platform delivery log. Never returns rendered text, `dataEnc` or `destinationEnc`; a search by recipient is audited (without the recipient). */
export interface DeliveryQuery {
  societyId?: number;
  channel?: string;
  status?: string;
  templateKey?: string;
  recipient?: string;
  from?: Date;
  to?: Date;
  page: number;
  limit: number;
  sortBy: 'createdAt';
  sortOrder: 'asc' | 'desc';
}

const item = (n: Notification) => ({
  id: n.id,
  societyId: n.societyId,
  templateKey: n.templateKey,
  channel: n.channel,
  destinationMasked: n.destinationMasked,
  status: n.status,
  skipReason: n.skipReason,
  attempts: n.attempts,
  providerKey: n.providerKey,
  lastErrorCode: n.lastErrorCode,
  limitBypassed: n.limitBypassed,
  createdAt: n.createdAt,
  sentAt: n.sentAt,
  deliveredAt: n.deliveredAt,
});

export async function searchDeliveries(ctx: Ctx, q: DeliveryQuery) {
  const where: WhereOptions[] = [];
  if (q.societyId) where.push({ societyId: q.societyId });
  if (q.channel) where.push({ channel: q.channel });
  if (q.status) where.push({ status: q.status });
  if (q.templateKey) where.push({ templateKey: q.templateKey });
  if (q.recipient)
    where.push({
      recipientKey: /^\d{10}$/.test(q.recipient) ? mobileKey(q.recipient) : emailKey(q.recipient),
    });
  if (q.from) where.push({ createdAt: { [Op.gte]: q.from } });
  if (q.to) where.push({ createdAt: { [Op.lt]: q.to } });
  const { rows, count } = await Notification.findAndCountAll({
    where: where.length ? { [Op.and]: where } : {},
    attributes: { exclude: ['dataEnc', 'destinationEnc', 'lastErrorMessage'] },
    order: [
      ['createdAt', q.sortOrder.toUpperCase()],
      ['id', q.sortOrder.toUpperCase()],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  if (q.recipient)
    await audit(ctx, {
      action: AUDIT.deliveriesSearched,
      entityType: ENTITY.notification,
      entityId: 0,
      entityLabel: 'delivery search by recipient',
      after: { recipientKind: /^\d{10}$/.test(q.recipient) ? 'MOBILE' : 'EMAIL', results: count },
    });
  return { data: rows.map(item), pagination: pageMeta(q.page, q.limit, count) };
}
