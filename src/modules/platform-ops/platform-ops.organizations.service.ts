import { Op, UniqueConstraintError } from 'sequelize';
import { Organization, Society, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import { ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { subscriptions } from '../subscriptions/subscriptions.public';
import { isReservedSlug } from '../societies/societies.slug';
import { AUDIT, ENTITY } from './platform-ops.types';
import { likeEscape } from './platform-ops.tickets.view';

/** Organizations: Enterprise groupings of societies (module 07 section 8.12, BR-07-51 to BR-07-53). */
const notFound = () => new NotFoundError('ORGANIZATION_NOT_FOUND', 'Organization not found');
const mask = (m: string | null) => (m ? `${m.slice(0, 2)}XXXXX${m.slice(-3)}` : null);

async function view(o: Organization, withSocieties: boolean) {
  const societies = await Society.findAll({
    where: { organizationId: o.id! },
    attributes: ['id', 'name', 'status'],
    order: [['name', 'ASC']],
  });
  const plans = withSocieties
    ? await subscriptions.summaryForSocieties(societies.map(s => s.id!))
    : new Map<number, { planKey?: string | null }>();
  return {
    id: o.id!,
    name: o.name,
    slug: o.slug,
    status: o.status,
    gstin: o.gstin,
    contactEmail: o.contactEmail,
    contactMobileMasked: mask(o.contactMobile),
    societyCount: societies.length,
    ...(withSocieties
      ? {
          societies: societies.map(s => ({
            id: s.id!,
            name: s.name,
            status: s.status,
            planKey: plans.get(s.id!)?.planKey ?? null,
          })),
        }
      : {}),
    createdAt: o.createdAt!.toISOString(),
    updatedAt: o.updatedAt!.toISOString(),
  };
}

export interface OrganizationQuery {
  status?: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  q?: string;
  sortBy: 'name' | 'createdAt';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

export async function listOrganizations(q: OrganizationQuery) {
  const and: Record<string, unknown>[] = [];
  if (q.status) and.push({ status: q.status });
  if (q.q)
    and.push({
      [Op.or]: [
        { name: { [Op.like]: `%${likeEscape(q.q)}%` } },
        { slug: { [Op.like]: `${likeEscape(q.q.toLowerCase())}%` } },
      ],
    });
  const { rows, count } = await Organization.findAndCountAll({
    where: { [Op.and]: and },
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'ASC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return {
    data: await Promise.all(rows.map(o => view(o, false))),
    pagination: pageMeta(q.page, q.limit, count),
  };
}

export async function getOrganization(id: number) {
  const o = await Organization.findByPk(id);
  if (!o) throw notFound();
  return view(o, true);
}

export interface OrganizationInput {
  name: string;
  slug: string;
  gstin?: string | null;
  contactEmail?: string | null;
  contactMobile?: string | null;
}

const slugTaken = () => new ConflictError('ORGANIZATION_SLUG_TAKEN', 'This slug is already used');

/** BR-07-51: slugs are never reused, including those of closed organizations (paranoid rows count too). */
export async function createOrganization(ctx: Ctx, input: OrganizationInput) {
  if (isReservedSlug(input.slug)) throw slugTaken();
  const id = await sequelize
    .transaction(async t => {
      if (await Organization.findOne({ where: { slug: input.slug }, paranoid: false, transaction: t }))
        throw slugTaken();
      const o = await Organization.create(
        {
          name: input.name,
          slug: input.slug,
          status: 'ACTIVE',
          gstin: input.gstin ?? null,
          contactEmail: input.contactEmail ?? null,
          contactMobile: input.contactMobile ?? null,
        },
        { transaction: t },
      );
      await audit(
        ctx,
        {
          action: AUDIT.organizationCreated,
          entityType: ENTITY.organization,
          entityId: o.id!,
          entityLabel: o.name,
          after: {
            name: o.name,
            slug: o.slug,
            gstin: o.gstin,
            contactEmail: o.contactEmail,
            contactMobile: o.contactMobile,
          },
        },
        t,
      );
      return o.id!;
    })
    .catch(e => {
      if (e instanceof UniqueConstraintError) throw slugTaken();
      throw e;
    });
  return getOrganization(id);
}

/** BR-07-53: no version column, last write wins; every edit is audited with before and after. */
export async function updateOrganization(
  ctx: Ctx,
  id: number,
  input: Partial<Omit<OrganizationInput, 'slug'>>,
) {
  await sequelize.transaction(async t => {
    const o = await Organization.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!o) throw notFound();
    if (o.status === 'CLOSED')
      throw new ConflictError('INVALID_STATE', 'A closed organization cannot be edited');
    const fields = ['name', 'gstin', 'contactEmail', 'contactMobile'] as const;
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const f of fields)
      if (input[f] !== undefined && input[f] !== o[f]) {
        before[f] = o[f];
        after[f] = input[f];
      }
    if (!Object.keys(after).length) return;
    await o.update(after, { transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.organizationUpdated,
        entityType: ENTITY.organization,
        entityId: o.id!,
        entityLabel: o.name,
        before,
        after,
      },
      t,
    );
  });
  return getOrganization(id);
}

/** BR-07-52: ACTIVE and SUSPENDED move both ways, both can close, CLOSED is final; closing needs every society CLOSED. */
export async function setOrganizationStatus(
  ctx: Ctx,
  id: number,
  input: { status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED'; reason: string },
) {
  if (input.status === 'CLOSED' && !ctx.platformPermissions?.has('platform.societies.delete'))
    throw new ForbiddenError('PERMISSION_DENIED', 'You do not have permission to close an organization');
  await sequelize.transaction(async t => {
    const o = await Organization.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!o) throw notFound();
    if (o.status === 'CLOSED' || o.status === input.status)
      throw new ConflictError('INVALID_STATE', 'The organization is already in this state');
    if (input.status === 'CLOSED') {
      const open = await Society.count({
        where: { organizationId: id, status: { [Op.ne]: 'CLOSED' } },
        transaction: t,
      });
      if (open > 0)
        throw new ConflictError(
          'ORGANIZATION_HAS_SOCIETIES',
          'Close or unlink every society of this organization first',
        );
    }
    const from = o.status;
    await o.update({ status: input.status }, { transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.organizationStatusChanged,
        entityType: ENTITY.organization,
        entityId: o.id!,
        entityLabel: o.name,
        before: { status: from },
        after: { status: input.status },
        reason: input.reason,
      },
      t,
    );
  });
  return getOrganization(id);
}
