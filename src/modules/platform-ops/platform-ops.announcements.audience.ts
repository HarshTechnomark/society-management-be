import { Op } from 'sequelize';
import { Role, Society, SocietyMember } from '../../models';
import type { PlatformNotification } from '../../models/platform-notification.model';
import { subscriptions } from '../subscriptions/subscriptions.public';

/** Who an announcement reaches (BR-07-38). The banner audience is matched live; the fan-out snapshot is taken at publish. */
export const ROLE_KEYS = [
  'chairman',
  'secretary',
  'treasurer',
  'committee_member',
  'society_admin',
  'accountant',
  'facility_manager',
  'security_supervisor',
  'auditor',
] as const;
export const DEFAULT_INCIDENT_ROLES = ['chairman', 'secretary', 'treasurer', 'society_admin'];

export interface Audience {
  audienceType: PlatformNotification['audienceType'];
  audiencePlanKeys: string[] | null;
  audienceSocietyStatuses: string[] | null;
  audienceSocietyIds: number[] | null;
  audienceRoleKeys: string[];
}

/** Societies matching the audience (never CLOSED), by id. */
export async function audienceSocietyIds(a: Audience): Promise<number[]> {
  const where: Record<string, unknown> = { status: { [Op.ne]: 'CLOSED' } };
  if (a.audienceType === 'SOCIETY_STATUSES') where.status = { [Op.in]: a.audienceSocietyStatuses ?? [] };
  if (a.audienceType === 'SOCIETIES') where.id = { [Op.in]: a.audienceSocietyIds ?? [] };
  const rows = await Society.findAll({ where, attributes: ['id', 'status'], order: [['id', 'ASC']] });
  let ids = rows.filter(r => r.status !== 'CLOSED').map(r => r.id!);
  if (a.audienceType === 'PLANS') {
    const plans = await subscriptions.summaryForSocieties(ids);
    const keys = new Set((a.audiencePlanKeys ?? []).map(k => k.toUpperCase()));
    ids = ids.filter(id => keys.has(plans.get(id)?.planKey ?? ''));
  }
  return ids;
}

/** Live match of one society (the banner read path). */
export function matchesAudience(
  a: Audience,
  society: { id: number; status: string; planKey: string },
): boolean {
  if (society.status === 'CLOSED') return false;
  switch (a.audienceType) {
    case 'ALL':
      return true;
    case 'PLANS':
      return (a.audiencePlanKeys ?? []).some(k => k.toUpperCase() === society.planKey.toUpperCase());
    case 'SOCIETY_STATUSES':
      return (a.audienceSocietyStatuses ?? []).includes(society.status);
    case 'SOCIETIES':
      return (a.audienceSocietyIds ?? []).includes(society.id);
  }
}

/** ACTIVE members holding one of the role keys, in the given societies, ordered by society then member id. */
export async function recipientRows(
  societyIds: number[],
  roleKeys: string[],
  after: { societyId: number; memberId: number } | null,
  limit: number,
): Promise<{ societyId: number; memberId: number; userId: number }[]> {
  if (!societyIds.length) return [];
  const where: Record<string, unknown> = {
    societyId: { [Op.in]: societyIds },
    status: 'ACTIVE',
  };
  if (after)
    Object.assign(where, {
      [Op.or]: [
        { societyId: { [Op.gt]: after.societyId } },
        { societyId: after.societyId, id: { [Op.gt]: after.memberId } },
      ],
    });
  const rows = await SocietyMember.findAll({
    where,
    attributes: ['id', 'societyId', 'userId'],
    include: [{ model: Role, attributes: [], required: true, where: { key: { [Op.in]: roleKeys } } }],
    order: [
      ['societyId', 'ASC'],
      ['id', 'ASC'],
    ],
    limit,
  });
  return rows.map(r => ({ societyId: r.societyId, memberId: r.id!, userId: r.userId }));
}

/** Societies with at least one recipient, and distinct recipient users (audience preview and publish check). */
export async function countAudience(
  a: Audience,
): Promise<{ societyIds: number[]; societies: number; recipients: number }> {
  const all = await audienceSocietyIds(a);
  const users = new Set<number>();
  const withRecipients = new Set<number>();
  let after: { societyId: number; memberId: number } | null = null;
  for (;;) {
    const page = await recipientRows(all, a.audienceRoleKeys, after, 1000);
    for (const r of page) {
      users.add(r.userId);
      withRecipients.add(r.societyId);
    }
    if (page.length < 1000) break;
    const last = page[page.length - 1]!;
    after = { societyId: last.societyId, memberId: last.memberId };
  }
  return { societyIds: [...withRecipients], societies: withRecipients.size, recipients: users.size };
}
