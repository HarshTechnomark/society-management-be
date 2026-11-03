import { Op, type Transaction } from 'sequelize';
import { MoveRequest, Pet, Resident, Tenancy, UnitResident, sequelize } from '../../models';
import type { ResidentSource } from '../../models/resident.model';
import type { FamilyRelation, LinkEndReason, LinkRelation } from '../../models/unit-resident.model';
import { audit } from '../../utils/audit';
import { AppError, NotFoundError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { revokeHouseholdGrants } from '../access-control/access-control.public';
import { units } from '../society-setup/society-setup.public';
import type { UnitDto } from '../society-setup/society-setup.types';
import {
  AUDIT,
  ENTITY,
  FEATURE,
  LIVE_TENANCY,
  OPEN_MOVE_STATUSES,
  OWNER_RELATIONS,
  type Household,
} from './residents.constants';
import { emitAfterCommit, notifyAfterCommit, recipients } from './residents.notify';
import { residentPorts, touchReports } from './residents.ports';
import {
  addDaysYmd,
  assertFeatureFor,
  centsToShare,
  featureOn,
  invalidState,
  isMinor,
  isOwnerRelation,
  isUniqueViolation,
  linkNotFound,
  residentNotFound,
  rule,
  shareCents,
  shareOut,
  societyToday,
  staleVersion,
} from './residents.shared';
import { occupancyOfIn } from './residents.occupancy';
import { syncMembership } from './residents.sync';

/**
 * Unit links (sections 5.2 and 8.8 to 8.10). Every write takes the locks of BR-09-19 in this order: the unit row
 * (`units.lockActive`), then the unit's link rows, then the tenancy, then the request row. `createLink` and `endLinks` are
 * the functions the other parts of module 09 (tenancies, join requests, moves, transfers) call inside their transaction.
 */
export interface NewLink {
  residentId: number;
  unitId: number;
  relation: LinkRelation;
  familyRelation?: FamilyRelation | null;
  householdOf?: Household | null;
  sharePercent?: string | null;
  isPrimary?: boolean;
  isResiding?: boolean;
  canLogin?: boolean;
  fromDate: string;
  tenancyId?: number | null;
  ownershipTransferId?: number | null;
  source?: ResidentSource;
}
export interface LinkOptions {
  /** Check the plan feature of the relation (default true; the demo seed turns it off). */
  checkFeature?: boolean;
  /** The caller is the tenancy or transfer flow: TENANT links are allowed and minors may be owners (inheritance). */
  internal?: boolean;
  allowMinorOwner?: boolean;
  /** Import: shares are validated by the caller once all owner rows of the unit are in. */
  skipShareCheck?: boolean;
  /** The caller already holds the unit lock in this transaction (tenancy and transfer flows), so it is not locked again. */
  already?: UnitDto;
}

const featureOfRelation = (r: LinkRelation) =>
  r === 'OWNER'
    ? FEATURE.ownership
    : r === 'CO_OWNER'
      ? FEATURE.jointOwnership
      : r === 'TENANT'
        ? FEATURE.tenancies
        : FEATURE.family;

const OWNER_IN = { [Op.in]: [...OWNER_RELATIONS] };

export const lockLinks = (societyId: number, unitId: number, t: Transaction) =>
  UnitResident.findAll({
    where: { societyId, unitId },
    order: [['id', 'ASC']],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

/** The live tenancy of a unit (BR-09-15): APPROVED, ACTIVE or EXPIRED_OVERSTAY, the newest first. */
export const liveTenancyOf = (societyId: number, unitId: number, t?: Transaction) =>
  Tenancy.findOne({
    where: { societyId, unitId, status: { [Op.in]: [...LIVE_TENANCY] } },
    order: [['id', 'DESC']],
    transaction: t,
  });

// ------------------------------------------------------------------ invariants after owner links change
/**
 * BR-09-14 and BR-09-12 after an owner link ended or was promoted: exactly one open owner link is primary, a sole owner
 * carries no share (treated as 100), and shares of several owners still total 100.00 (re-scaled when one left).
 */
export async function repairOwners(
  societyId: number,
  unitId: number,
  t: Transaction,
  preferPrimaryLinkId?: number,
): Promise<void> {
  const open = await UnitResident.findAll({
    where: { societyId, unitId, toDate: null, relation: OWNER_IN },
    order: [['id', 'ASC']],
    transaction: t,
  });
  if (!open.length) return;
  if (!open.some(l => l.isPrimary)) {
    const pick =
      open.find(l => l.id === preferPrimaryLinkId) ?? open.find(l => l.relation === 'OWNER') ?? open[0]!;
    pick.isPrimary = true;
    pick.version += 1;
    await pick.save({ transaction: t });
  }
  const shared = open.filter(l => l.sharePercent !== null);
  if (!shared.length) return;
  if (open.length === 1) {
    open[0]!.sharePercent = null;
    open[0]!.version += 1;
    await open[0]!.save({ transaction: t });
    return;
  }
  const sum = shared.reduce((a, l) => a + shareCents(l.sharePercent!), 0);
  if (sum === 10000 && shared.length === open.length) return;
  const base = shared.map(l => Math.max(1, Math.floor((shareCents(l.sharePercent!) * 10000) / sum)));
  const rest = 10000 - base.reduce((a, b) => a + b, 0);
  const lead = Math.max(
    0,
    shared.findIndex(l => l.isPrimary),
  );
  base[lead] = base[lead]! + rest;
  for (let i = 0; i < shared.length; i++) {
    shared[i]!.sharePercent = centsToShare(base[i]!);
    shared[i]!.version += 1;
    await shared[i]!.save({ transaction: t });
  }
}

/** BR-09-12 on the owner set after a change: all or none carry a share, and the shares total exactly 100.00. */
export function assertShares(owners: { sharePercent: string | null }[]): void {
  const some = owners.some(o => o.sharePercent !== null);
  if (!some) return;
  if (owners.some(o => o.sharePercent === null))
    throw rule(
      422,
      'OWNERSHIP_SHARE_INVALID',
      'Every owner needs a share once one has a share. Set them together.',
      'sharePercent',
    );
  const sum = owners.reduce((a, o) => a + shareCents(o.sharePercent!), 0);
  if (sum !== 10000)
    throw rule(
      422,
      'OWNERSHIP_SHARE_INVALID',
      `The shares must total exactly 100.00 (now ${centsToShare(sum)}).`,
      'sharePercent',
    );
}

// ------------------------------------------------------------------ create (5.2, 8.5 link, 8.8 POST)
export async function createLink(
  ctx: Ctx,
  societyId: number,
  input: NewLink,
  t: Transaction,
  opts: LinkOptions = {},
): Promise<UnitResident> {
  if (opts.checkFeature !== false) await assertFeatureFor(societyId, featureOfRelation(input.relation));
  const unit = opts.already ?? (await units.lockActive(societyId, input.unitId, t));
  const ownerType = isOwnerRelation(input.relation);
  if (!ownerType && unit.unitType === 'PARKING_ONLY')
    throw rule(
      422,
      'UNIT_NOT_RESIDENTIAL',
      'This unit is a parking space; only owners can be linked',
      'unitId',
    );
  if (input.relation === 'TENANT' && !opts.internal)
    throw rule(422, 'USE_TENANCY_FLOW', 'Tenants are added through a tenancy', 'relation');
  const today = await societyToday(societyId);
  const resident = await Resident.findOne({
    where: { id: input.residentId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!resident) throw residentNotFound();
  const links = await lockLinks(societyId, input.unitId, t);

  const minor = isMinor(resident.dateOfBirth, today);
  if (minor && (ownerType || input.relation === 'TENANT') && !(opts.allowMinorOwner && ownerType))
    throw rule(422, 'MINOR_NOT_ALLOWED', 'A minor cannot be an owner or a tenant', 'residentId');
  if (input.fromDate > addDaysYmd(today, 90))
    throw rule(422, 'LINK_DATES_INVALID', 'The start date is too far ahead', 'fromDate');
  if (input.sharePercent !== undefined && input.sharePercent !== null && !ownerType)
    throw rule(422, 'OWNERSHIP_SHARE_INVALID', 'Only owner links carry a share', 'sharePercent');
  if (input.isPrimary && !ownerType)
    throw rule(422, 'PRIMARY_MUST_BE_OWNER', 'Only an owner link can be the primary contact', 'isPrimary');

  // BR-09-13: one open link per resident and unit, and no overlap with an earlier period
  const mine = links.filter(l => l.residentId === input.residentId);
  if (mine.some(l => l.toDate === null))
    throw rule(409, 'LINK_ALREADY_ACTIVE', 'This person is already linked to the flat', 'residentId');
  if (mine.some(l => l.toDate !== null && l.toDate >= l.fromDate && l.toDate >= input.fromDate))
    throw rule(409, 'LINK_ALREADY_ACTIVE', 'This link overlaps an earlier link of the person', 'fromDate');

  // BR-09-11
  const openOwners = links.filter(l => l.toDate === null && isOwnerRelation(l.relation));
  if (input.relation === 'OWNER' && links.some(l => l.toDate === null && l.relation === 'OWNER'))
    throw rule(
      409,
      'OWNER_ALREADY_EXISTS',
      'The flat already has an owner. Add a co-owner instead.',
      'relation',
    );
  if (input.relation === 'CO_OWNER' && !links.some(l => l.toDate === null && l.relation === 'OWNER'))
    throw rule(422, 'OWNER_REQUIRED', 'A co-owner needs an owner on the flat first', 'relation');

  // BR-09-15 household
  let tenancyId = input.tenancyId ?? null;
  if (input.relation === 'FAMILY' || input.relation === 'CARETAKER') {
    if (input.relation === 'FAMILY' && !input.familyRelation)
      throw rule(422, 'LINK_DATES_INVALID', 'Choose how this person is related', 'familyRelation');
    if (input.householdOf === 'TENANT') {
      const live = await liveTenancyOf(societyId, input.unitId, t);
      if (!live) throw rule(422, 'NO_LIVE_TENANCY', 'The flat has no live tenancy', 'householdOf');
      tenancyId = live.id!;
    } else if (!tenancyId) tenancyId = null;
  }

  // BR-09-12 shares and BR-09-14 primary
  const share = ownerType ? (input.sharePercent ? centsToShare(shareCents(input.sharePercent)) : null) : null;
  if (ownerType && !opts.skipShareCheck)
    assertShares([...openOwners.map(o => ({ sharePercent: o.sharePercent })), { sharePercent: share }]);
  let primary = false;
  if (ownerType) {
    const current = openOwners.find(o => o.isPrimary);
    primary = input.isPrimary === true || !current;
    if (primary && current) {
      current.isPrimary = false;
      current.version += 1;
      await current.save({ transaction: t });
    }
  }

  const firstEver =
    (await UnitResident.count({ where: { societyId, residentId: input.residentId }, transaction: t })) === 0;
  let link: UnitResident;
  try {
    link = await UnitResident.create(
      {
        societyId,
        unitId: input.unitId,
        residentId: input.residentId,
        relation: input.relation,
        familyRelation: input.relation === 'FAMILY' ? (input.familyRelation ?? null) : null,
        sharePercent: share,
        isPrimary: primary,
        isResiding: input.isResiding ?? true,
        canLogin: input.canLogin ?? !minor,
        tenancyId,
        ownershipTransferId: input.ownershipTransferId ?? null,
        fromDate: input.fromDate,
        toDate: null,
        endReason: null,
        endNote: null,
        source: input.source ?? 'ADMIN',
        version: 1,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      const m = String((err as { parent?: { message?: string } }).parent?.message ?? '');
      if (m.includes('uq_ur_owner'))
        throw rule(409, 'OWNER_ALREADY_EXISTS', 'The flat already has an owner', 'relation');
      throw rule(409, 'LINK_ALREADY_ACTIVE', 'This person is already linked to the flat', 'residentId');
    }
    throw err;
  }
  if (resident.status !== 'ACTIVE') {
    resident.status = 'ACTIVE';
    resident.version += 1;
    await resident.save({ transaction: t });
  }
  await audit(
    ctx,
    {
      action: AUDIT.linkCreated,
      entityType: ENTITY.link,
      entityId: link.id!,
      societyId,
      after: {
        residentId: input.residentId,
        unitId: input.unitId,
        relation: input.relation,
        sharePercent: share,
        isPrimary: primary,
        fromDate: input.fromDate,
      },
    },
    t,
  );
  await syncMembership(ctx, t, input.residentId, { societyId });
  emitAfterCommit(t, `unit:${input.unitId}`, 'household.changed', { unitId: input.unitId });
  touchReports(t, societyId);
  if (resident.userId !== null && firstEver && (await featureOn(societyId, FEATURE.welcomeKit)))
    notifyAfterCommit(t, 'residents.welcome_kit', societyId, recipients.users([resident.userId]), {
      name: resident.name,
      unitLabel: unit.label,
      link: '/home',
    });
  return link;
}

// ------------------------------------------------------------------ end (BR-09-9, 11, 14, 18, 69)
export interface EndSpec {
  toDate: string;
  reason: LinkEndReason;
  note?: string | null;
}
const dayBefore = (d: string): string => addDaysYmd(d, -1);

/** The `toDate` and reason a link gets when the wanted end date lies before its start (BR-09-9 cancellation). */
export function endFor(l: UnitResident, spec: EndSpec): { toDate: string; reason: LinkEndReason } {
  return spec.toDate < l.fromDate
    ? { toDate: dayBefore(l.fromDate), reason: 'CORRECTION' }
    : { toDate: spec.toDate, reason: spec.reason };
}

/**
 * Ends open links of one unit inside the caller's transaction (the unit and the link rows are already locked): clears
 * `isPrimary`, sets `toDate`, calls module 12 and 19 (BR-09-18) and module 03 `revokeHouseholdGrants`, repairs the owner
 * invariants, sets pets INACTIVE (BR-09-69) and runs `syncMembership` for every affected resident.
 */
export async function endLinks(
  ctx: Ctx,
  societyId: number,
  unitId: number,
  rows: UnitResident[],
  spec: EndSpec,
  t: Transaction,
  o: { promoteLinkId?: number } = {},
): Promise<void> {
  if (!rows.length) return;
  const residents = new Map<number, Resident>();
  for (const r of await Resident.findAll({
    where: { id: { [Op.in]: [...new Set(rows.map(l => l.residentId))] }, societyId },
    paranoid: false,
    transaction: t,
  }))
    residents.set(r.id!, r);
  let ownerChanged = false;
  for (const l of rows) {
    const e = endFor(l, spec);
    const before = { toDate: null, isPrimary: l.isPrimary };
    l.toDate = e.toDate;
    l.endReason = e.reason;
    l.endNote = spec.note ?? null;
    l.isPrimary = false;
    l.version += 1;
    l.updatedBy = ctx.user?.id ?? null;
    await l.save({ transaction: t });
    if (isOwnerRelation(l.relation)) ownerChanged = true;
    const res = residents.get(l.residentId);
    if (res?.userId) await residentPorts().payments.onUnitLinkEnded(ctx, unitId, res.userId, t);
    await residentPorts().parking.onUnitLinkEnded(ctx, unitId, l.residentId, t);
    if ((l.relation === 'FAMILY' || l.relation === 'CARETAKER') && res?.memberId)
      await revokeHouseholdGrants(t, societyId, res.memberId, unitId);
    await audit(
      ctx,
      {
        action: AUDIT.linkEnded,
        entityType: ENTITY.link,
        entityId: l.id!,
        societyId,
        before,
        after: { toDate: e.toDate, endReason: e.reason, relation: l.relation, residentId: l.residentId },
      },
      t,
    );
  }
  if (o.promoteLinkId) {
    const p = await UnitResident.findByPk(o.promoteLinkId, { transaction: t });
    if (p) {
      p.relation = 'OWNER';
      p.version += 1;
      await p.save({ transaction: t });
    }
  }
  if (ownerChanged) await repairOwners(societyId, unitId, t, o.promoteLinkId);
  // BR-09-69: pets of a resident whose last link on the unit ended
  for (const rid of new Set(rows.map(l => l.residentId))) {
    const stillOpen = await UnitResident.count({
      where: { societyId, unitId, residentId: rid, toDate: null },
      transaction: t,
    });
    if (stillOpen === 0)
      await Pet.update(
        { status: 'INACTIVE', inactiveReason: 'MOVED_OUT' },
        { where: { societyId, unitId, ownerResidentId: rid, status: 'ACTIVE' }, transaction: t },
      );
  }
  for (const rid of new Set(rows.map(l => l.residentId))) await syncMembership(ctx, t, rid, { societyId });
  emitAfterCommit(t, `unit:${unitId}`, 'household.changed', { unitId });
  touchReports(t, societyId);
}

export interface EndInput {
  toDate: string;
  endReason: Exclude<LinkEndReason, 'TENANCY_ENDED' | 'TERMINATED'>;
  endNote?: string | null;
  promoteLinkId?: number;
  version: number;
}

/** `POST /residents/links/:linkId/end` (8.8). */
export async function endLink(ctx: Ctx, societyId: number, linkId: number, input: EndInput): Promise<void> {
  await sequelize.transaction(async t => {
    const found = await UnitResident.findOne({ where: { id: linkId, societyId }, transaction: t });
    if (!found) throw linkNotFound();
    await units.lockActive(societyId, found.unitId, t);
    const links = await lockLinks(societyId, found.unitId, t);
    const link = links.find(l => l.id === linkId)!;
    if (link.toDate !== null) throw invalidState('This link has already ended');
    if (link.version !== input.version) throw staleVersion('This link');
    if (link.relation === 'TENANT')
      throw rule(422, 'USE_TENANCY_FLOW', 'Tenants are ended through their tenancy', 'linkId');
    const today = await societyToday(societyId);
    if (input.toDate > today || input.toDate < dayBefore(link.fromDate))
      throw rule(
        422,
        'LINK_DATES_INVALID',
        'The end date must be between the day before the start and today',
        'toDate',
      );
    if (input.toDate < link.fromDate && input.endReason !== 'CORRECTION')
      throw rule(422, 'LINK_DATES_INVALID', 'An end before the start date is a correction', 'endReason');
    if ((input.endReason === 'OTHER' || input.endReason === 'DECEASED') && !input.endNote?.trim())
      throw rule(422, 'LINK_DATES_INVALID', 'Add a note for this reason', 'endNote');
    let promote: UnitResident | undefined;
    if (link.relation === 'OWNER') {
      const coOwners = links.filter(l => l.toDate === null && l.relation === 'CO_OWNER');
      if (coOwners.length) {
        if (!input.promoteLinkId)
          throw rule(
            422,
            'OWNER_REQUIRED',
            'Promote a co-owner to owner before ending the owner',
            'promoteLinkId',
          );
        promote = coOwners.find(l => l.id === input.promoteLinkId);
        if (!promote) throw linkNotFound();
      } else if (await liveTenancyOf(societyId, link.unitId, t))
        throw rule(422, 'OWNER_REQUIRED', 'The flat has a tenant and needs an owner', 'linkId');
    }
    if (link.relation === 'CO_OWNER' && input.promoteLinkId) throw linkNotFound();
    await endLinks(
      ctx,
      societyId,
      link.unitId,
      [link],
      { toDate: input.toDate, reason: input.endReason, note: input.endNote ?? null },
      t,
      { promoteLinkId: promote?.id },
    );
  });
}

// ------------------------------------------------------------------ update (8.8 PATCH)
export interface PatchLinkInput {
  sharePercent?: string | null;
  isPrimary?: true;
  isResiding?: boolean;
  canLogin?: boolean;
  familyRelation?: FamilyRelation;
  version: number;
}

export async function patchLink(
  ctx: Ctx,
  societyId: number,
  linkId: number,
  input: PatchLinkInput,
): Promise<UnitResident> {
  return sequelize.transaction(async t => {
    const found = await UnitResident.findOne({ where: { id: linkId, societyId }, transaction: t });
    if (!found) throw linkNotFound();
    await units.lockActive(societyId, found.unitId, t);
    const links = await lockLinks(societyId, found.unitId, t);
    const link = links.find(l => l.id === linkId)!;
    if (link.toDate !== null) throw invalidState('This link has already ended');
    if (link.version !== input.version) throw staleVersion('This link');
    const before = {
      sharePercent: link.sharePercent,
      isPrimary: link.isPrimary,
      isResiding: link.isResiding,
      canLogin: link.canLogin,
    };
    const ownerType = isOwnerRelation(link.relation);
    if (input.sharePercent !== undefined) {
      if (!ownerType && input.sharePercent !== null)
        throw rule(422, 'OWNERSHIP_SHARE_INVALID', 'Only owner links carry a share', 'sharePercent');
      link.sharePercent = input.sharePercent === null ? null : centsToShare(shareCents(input.sharePercent));
      assertShares(
        links
          .filter(l => l.toDate === null && isOwnerRelation(l.relation))
          .map(l => ({ sharePercent: l.sharePercent })),
      );
    }
    if (input.isPrimary) {
      if (!ownerType)
        throw rule(
          422,
          'PRIMARY_MUST_BE_OWNER',
          'Only an owner link can be the primary contact',
          'isPrimary',
        );
      for (const o of links.filter(l => l.toDate === null && l.isPrimary && l.id !== link.id)) {
        o.isPrimary = false;
        o.version += 1;
        await o.save({ transaction: t });
      }
      link.isPrimary = true;
    }
    if (input.isResiding !== undefined) link.isResiding = input.isResiding;
    if (input.canLogin !== undefined) link.canLogin = input.canLogin;
    if (input.familyRelation !== undefined) {
      if (link.relation !== 'FAMILY')
        throw rule(422, 'LINK_DATES_INVALID', 'Only a family link has a family relation', 'familyRelation');
      link.familyRelation = input.familyRelation;
    }
    link.version += 1;
    link.updatedBy = ctx.user?.id ?? null;
    await link.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.linkUpdated,
        entityType: ENTITY.link,
        entityId: link.id!,
        societyId,
        before,
        after: {
          sharePercent: link.sharePercent,
          isPrimary: link.isPrimary,
          isResiding: link.isResiding,
          canLogin: link.canLogin,
        },
      },
      t,
    );
    await syncMembership(ctx, t, link.residentId, { societyId });
    emitAfterCommit(t, `unit:${link.unitId}`, 'household.changed', { unitId: link.unitId });
    touchReports(t, societyId);
    return link;
  });
}

// ------------------------------------------------------------------ shares (8.9)
export interface SharesInput {
  shares: { linkId: number; sharePercent: string }[];
  primaryLinkId: number;
  version: { linkId: number; version: number }[];
}

export async function setOwnershipShares(ctx: Ctx, societyId: number, unitId: number, input: SharesInput) {
  return sequelize.transaction(async t => {
    await units.lockActive(societyId, unitId, t);
    const links = await lockLinks(societyId, unitId, t);
    const owners = links.filter(l => l.toDate === null && isOwnerRelation(l.relation));
    const ids = new Set(input.shares.map(s => s.linkId));
    if (ids.size !== input.shares.length)
      throw rule(422, 'OWNERSHIP_SHARE_INVALID', 'A link is listed twice', 'shares');
    for (const s of input.shares)
      if (!links.some(l => l.id === s.linkId))
        throw new NotFoundError('LINK_NOT_FOUND', 'Unit link not found');
    if (owners.length !== ids.size || owners.some(o => !ids.has(o.id!)))
      throw rule(
        422,
        'OWNERSHIP_SHARE_INVALID',
        'List every open owner link of the flat exactly once',
        'shares',
      );
    const primary = owners.find(o => o.id === input.primaryLinkId);
    if (!primary) {
      if (links.some(l => l.id === input.primaryLinkId))
        throw rule(
          422,
          'PRIMARY_MUST_BE_OWNER',
          'The primary contact must be an open owner link',
          'primaryLinkId',
        );
      throw new NotFoundError('LINK_NOT_FOUND', 'Unit link not found');
    }
    for (const v of input.version) {
      const l = links.find(x => x.id === v.linkId);
      if (!l) throw new NotFoundError('LINK_NOT_FOUND', 'Unit link not found');
      if (l.version !== v.version) throw staleVersion('A link');
    }
    if (input.version.length !== owners.length)
      throw rule(422, 'OWNERSHIP_SHARE_INVALID', 'Send the version of every owner link', 'version');
    const next = new Map(input.shares.map(s => [s.linkId, centsToShare(shareCents(s.sharePercent))]));
    if ([...next.values()].some(v => shareCents(v) < 1))
      throw rule(422, 'OWNERSHIP_SHARE_INVALID', 'Every share must be at least 0.01', 'shares');
    assertShares(owners.map(o => ({ sharePercent: next.get(o.id!)! })));
    const before = owners.map(o => ({
      linkId: o.id,
      sharePercent: shareOut(o.sharePercent),
      isPrimary: o.isPrimary,
    }));
    for (const o of owners.filter(x => x.isPrimary && x.id !== primary.id)) {
      o.isPrimary = false;
      await o.save({ transaction: t });
    }
    for (const o of owners) {
      o.sharePercent = owners.length === 1 ? null : next.get(o.id!)!;
      o.isPrimary = o.id === primary.id;
      o.version += 1;
      o.updatedBy = ctx.user?.id ?? null;
      await o.save({ transaction: t });
    }
    await audit(
      ctx,
      {
        action: AUDIT.sharesUpdated,
        entityType: ENTITY.unit,
        entityId: unitId,
        societyId,
        before,
        after: owners.map(o => ({
          linkId: o.id,
          sharePercent: shareOut(o.sharePercent),
          isPrimary: o.isPrimary,
        })),
      },
      t,
    );
    emitAfterCommit(t, `unit:${unitId}`, 'household.changed', { unitId });
    touchReports(t, societyId);
    return owners.map(o => o.id!);
  });
}

// ------------------------------------------------------------------ vacate (BR-09-17, 8.10)
export async function vacateUnit(
  ctx: Ctx,
  societyId: number,
  unitId: number,
  input: { reason: string; effectiveDate?: string },
) {
  return sequelize.transaction(async t => {
    await units.lockActive(societyId, unitId, t);
    const links = await lockLinks(societyId, unitId, t);
    const today = await societyToday(societyId);
    const eff = input.effectiveDate ?? today;
    if (eff > today || eff < addDaysYmd(today, -30))
      throw rule(
        422,
        'LINK_DATES_INVALID',
        'The date must be within the last 30 days, not later than today',
        'effectiveDate',
      );
    if ((await occupancyOfIn(societyId, [unitId], today, t)).get(unitId) === 'VACANT')
      throw invalidState('The flat is already vacant');
    const open = await MoveRequest.count({
      where: { societyId, unitId, status: { [Op.in]: [...OPEN_MOVE_STATUSES] } },
      transaction: t,
    });
    if (open)
      throw new AppError(409, 'MOVE_REQUEST_EXISTS', 'Complete or cancel the open move request first');
    let endedTenancyId: number | null = null;
    const tenancy = await Tenancy.findOne({
      where: { societyId, unitId, status: { [Op.in]: [...LIVE_TENANCY] } },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const toEnd: UnitResident[] = [];
    if (tenancy) {
      endedTenancyId = tenancy.id!;
      tenancy.status = 'ENDED';
      tenancy.endedOn = eff < tenancy.agreementStart ? tenancy.agreementStart : eff;
      tenancy.endReason = 'TERMINATED';
      tenancy.endNote = input.reason.slice(0, 300);
      tenancy.version += 1;
      tenancy.updatedBy = ctx.user?.id ?? null;
      await tenancy.save({ transaction: t });
      toEnd.push(...links.filter(l => l.toDate === null && l.tenancyId === tenancy.id));
    }
    const household = links.filter(
      l =>
        l.toDate === null && l.tenancyId === null && (l.relation === 'FAMILY' || l.relation === 'CARETAKER'),
    );
    const tenantRows = toEnd.filter(l => !household.includes(l));
    if (tenantRows.length)
      await endLinks(
        ctx,
        societyId,
        unitId,
        tenantRows,
        { toDate: eff, reason: 'TERMINATED', note: input.reason },
        t,
      );
    if (household.length)
      await endLinks(
        ctx,
        societyId,
        unitId,
        household,
        { toDate: eff, reason: 'MOVED_OUT', note: input.reason },
        t,
      );
    const owners = links.filter(l => l.toDate === null && isOwnerRelation(l.relation));
    for (const o of owners) {
      o.isResiding = false;
      o.version += 1;
      await o.save({ transaction: t });
    }
    await audit(
      ctx,
      {
        action: AUDIT.unitVacated,
        entityType: ENTITY.unit,
        entityId: unitId,
        societyId,
        after: { endedLinks: tenantRows.length + household.length, endedTenancyId, effectiveDate: eff },
        reason: input.reason,
      },
      t,
    );
    for (const rid of new Set(owners.map(o => o.residentId)))
      await syncMembership(ctx, t, rid, { societyId });
    emitAfterCommit(t, `unit:${unitId}`, 'household.changed', { unitId });
    touchReports(t, societyId);
    return { occupancy: 'VACANT' as const, endedLinks: tenantRows.length + household.length, endedTenancyId };
  });
}
