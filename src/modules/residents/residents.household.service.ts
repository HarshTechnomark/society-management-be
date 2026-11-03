import { Op } from 'sequelize';
import { Resident, Tenancy, UnitResident, sequelize } from '../../models';
import type { FamilyRelation } from '../../models/unit-resident.model';
import { audit } from '../../utils/audit';
import { ForbiddenError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { units } from '../society-setup/society-setup.public';
import { AUDIT, ENTITY } from './residents.constants';
import { saveProfile, type EmergencyInput } from './residents.emergency.service';
import { linkDtos } from './residents.dto';
import { occupancyOfIn } from './residents.occupancy';
import { inviteResident, inviteResidentTx, type InviteResult } from './residents.invite.service';
import { endLinks, lockLinks, patchLink, createLink } from './residents.links.service';
import { createResident } from './residents.service';
import {
  invalidState,
  isMinor,
  linkNotFound,
  residentNotFound,
  rule,
  societyToday,
  unitNotFound,
} from './residents.shared';

/** The resident app household (section 8.18): the people of the caller's flats, and what the caller may change. */
const active = (date: string) => ({
  fromDate: { [Op.lte]: date },
  [Op.or]: [{ toDate: null }, { toDate: { [Op.gte]: date } }],
});
const controlRequired = () =>
  new ForbiddenError('HOUSEHOLD_CONTROL_REQUIRED', 'You do not manage this household');

interface Control {
  household: 'OWNER' | 'TENANT';
  tenancyId: number | null;
  caller: Resident;
}

/**
 * The household the caller manages on a unit: the owner household for OWNER and CO_OWNER, the tenancy household for TENANT
 * and for FAMILY or CARETAKER (their own household, usable only when module 03 gave them the household permission).
 */
async function controlOn(ctx: Ctx, societyId: number, unitId: number): Promise<Control> {
  if (!(ctx.unitIds ?? []).includes(unitId)) throw unitNotFound();
  const today = await societyToday(societyId);
  const caller = ctx.user ? await Resident.findOne({ where: { societyId, userId: ctx.user.id } }) : null;
  if (!caller) throw residentNotFound();
  const mine = await UnitResident.findAll({
    where: { societyId, unitId, residentId: caller.id!, ...active(today) },
    order: [['id', 'ASC']],
  });
  const own = mine.find(l => l.relation === 'OWNER' || l.relation === 'CO_OWNER');
  if (own) return { household: 'OWNER', tenancyId: null, caller };
  const other = mine[0];
  if (!other) throw unitNotFound();
  return { household: other.tenancyId === null ? 'OWNER' : 'TENANT', tenancyId: other.tenancyId, caller };
}

/** The household member link the caller may change, with its resident. */
async function memberLink(ctx: Ctx, societyId: number, linkId: number) {
  const link = await UnitResident.findOne({ where: { id: linkId, societyId } });
  if (!link || !(ctx.unitIds ?? []).includes(link.unitId)) throw linkNotFound();
  const c = await controlOn(ctx, societyId, link.unitId);
  if (link.relation !== 'FAMILY' && link.relation !== 'CARETAKER') throw controlRequired();
  if (link.tenancyId !== c.tenancyId) throw controlRequired();
  const resident = (await Resident.findOne({ where: { id: link.residentId, societyId } }))!;
  return { link, resident, control: c };
}

// ------------------------------------------------------------------ GET /me/household
export async function myHousehold(ctx: Ctx, societyId: number) {
  const unitIds = ctx.unitIds ?? [];
  if (!unitIds.length) return { units: [] };
  const today = await societyToday(societyId);
  const list = await units.listActive(societyId, { unitIds });
  const occ = await occupancyOfIn(societyId, unitIds, today);
  const out = [];
  for (const u of list) {
    const links = await UnitResident.findAll({
      where: { societyId, unitId: u.id, ...active(today) },
      order: [['id', 'ASC']],
    });
    const people = new Map(
      (await Resident.findAll({ where: { societyId, id: { [Op.in]: links.map(l => l.residentId) } } })).map(
        r => [r.id!, r],
      ),
    );
    const mineRel = (ctx.unitLinks ?? []).find(l => l.unitId === u.id)?.relation ?? 'FAMILY';
    const tn = await Tenancy.findOne({
      where: { societyId, unitId: u.id, status: { [Op.in]: ['APPROVED', 'ACTIVE', 'EXPIRED_OVERSTAY'] } },
      order: [['id', 'DESC']],
    });
    out.push({
      unitId: u.id,
      unitLabel: u.label,
      myRelation: mineRel,
      occupancy: occ.get(u.id)!,
      canManage: mineRel === 'OWNER' || mineRel === 'TENANT',
      people: links.map(l => {
        const r = people.get(l.residentId)!;
        return {
          linkId: l.id!,
          residentId: r.id!,
          name: r.name,
          relation: l.relation,
          familyRelation: l.familyRelation,
          isPrimary: Boolean(l.isPrimary),
          isMinor: isMinor(r.dateOfBirth, today),
          canLogin: Boolean(l.canLogin),
          isResiding: Boolean(l.isResiding),
          hasLogin: r.userId !== null,
          memberId: r.memberId,
          mobile: r.mobile,
          version: l.version,
        };
      }),
      tenancy: tn
        ? {
            id: tn.id!,
            status: tn.status,
            agreementEnd: tn.agreementEnd,
            policeVerificationStatus: tn.policeVerificationStatus,
          }
        : null,
    });
  }
  return { units: out };
}

// ------------------------------------------------------------------ POST /me/household/members
export interface AddMemberInput {
  unitId: number;
  name: string;
  relation: 'FAMILY' | 'CARETAKER';
  familyRelation?: FamilyRelation;
  mobile?: string;
  email?: string;
  dateOfBirth?: string;
  canLogin?: boolean;
  isResiding?: boolean;
  invite?: boolean;
}

export async function addMember(ctx: Ctx, societyId: number, input: AddMemberInput) {
  const control = await controlOn(ctx, societyId, input.unitId);
  if (input.invite && !input.mobile)
    throw rule(422, 'INVITE_NOT_POSSIBLE', 'To invite, add a mobile number', 'invite');
  const today = await societyToday(societyId);
  const link = {
    unitId: input.unitId,
    relation: input.relation,
    ...(input.familyRelation ? { familyRelation: input.familyRelation } : {}),
    householdOf: control.household,
    ...(input.canLogin !== undefined ? { canLogin: input.canLogin } : {}),
    ...(input.isResiding !== undefined ? { isResiding: input.isResiding } : {}),
    fromDate: today,
  };
  if (input.mobile) {
    const existing = await Resident.findOne({ where: { societyId, mobile: input.mobile } });
    if (existing) {
      const open = await UnitResident.findAll({
        where: { societyId, residentId: existing.id!, toDate: null },
      });
      if (open.some(l => l.unitId === input.unitId))
        throw rule(409, 'LINK_ALREADY_ACTIVE', 'This person is already linked to the flat', 'mobile');
      if (open.length)
        throw rule(
          409,
          'RESIDENT_MOBILE_EXISTS',
          'This mobile number belongs to a resident of another flat',
          'mobile',
          {
            hint: 'ASK_ADMIN',
          },
        );
      return sequelize.transaction(async t => {
        const l = await createLink(
          ctx,
          societyId,
          { ...link, residentId: existing.id!, source: 'HOUSEHOLD' },
          t,
        );
        let invitation: InviteResult | null = null;
        if (input.invite)
          invitation = await inviteResidentTx(ctx, societyId, existing.id!, { email: input.email }, t);
        return { link: (await linkDtos(societyId, [l]))[0]!, residentId: existing.id!, invitation };
      });
    }
  }
  const created = await createResident(
    ctx,
    societyId,
    {
      name: input.name,
      mobile: input.mobile ?? null,
      email: input.email ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
      link,
      invite: input.invite ?? false,
    },
    { source: 'HOUSEHOLD' },
  );
  return { link: created.links[0]!, residentId: created.id, invitation: created.invitation };
}

// ------------------------------------------------------------------ PATCH / DELETE / invite / emergency
export interface PatchMemberInput {
  name?: string;
  familyRelation?: FamilyRelation;
  dateOfBirth?: string | null;
  canLogin?: boolean;
  isResiding?: boolean;
  version: number;
}

export async function patchMember(ctx: Ctx, societyId: number, linkId: number, input: PatchMemberInput) {
  const { link, resident } = await memberLink(ctx, societyId, linkId);
  const profileEdit =
    input.name !== undefined || input.familyRelation !== undefined || input.dateOfBirth !== undefined;
  if (profileEdit && resident.userId !== null)
    throw rule(422, 'MEMBER_HAS_LOGIN', 'This person manages their own profile', 'name');
  if (input.name !== undefined || input.dateOfBirth !== undefined)
    await sequelize.transaction(async t => {
      const r = await Resident.findOne({
        where: { id: resident.id!, societyId },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!r) throw residentNotFound();
      if (input.name !== undefined) r.name = input.name;
      if (input.dateOfBirth !== undefined) r.dateOfBirth = input.dateOfBirth;
      r.version += 1;
      r.updatedBy = ctx.user?.id ?? null;
      await r.save({ transaction: t });
      await audit(
        ctx,
        {
          action: AUDIT.residentUpdated,
          entityType: ENTITY.resident,
          entityId: r.id!,
          societyId,
          after: { name: input.name, dateOfBirth: input.dateOfBirth },
        },
        t,
      );
    });
  const updated = await patchLink(ctx, societyId, link.id!, {
    version: input.version,
    ...(input.canLogin !== undefined ? { canLogin: input.canLogin } : {}),
    ...(input.isResiding !== undefined ? { isResiding: input.isResiding } : {}),
    ...(input.familyRelation !== undefined ? { familyRelation: input.familyRelation } : {}),
  });
  return (await linkDtos(societyId, [updated]))[0]!;
}

export async function removeMember(
  ctx: Ctx,
  societyId: number,
  linkId: number,
  reason?: string,
): Promise<void> {
  const { link } = await memberLink(ctx, societyId, linkId);
  await sequelize.transaction(async t => {
    await units.lockActive(societyId, link.unitId, t);
    const links = await lockLinks(societyId, link.unitId, t);
    const row = links.find(l => l.id === linkId)!;
    if (row.toDate !== null) throw invalidState('This person was removed already');
    const today = await societyToday(societyId);
    await endLinks(
      ctx,
      societyId,
      row.unitId,
      [row],
      { toDate: today < row.fromDate ? row.fromDate : today, reason: 'REMOVED', note: reason ?? null },
      t,
    );
  });
}

export async function inviteMember(
  ctx: Ctx,
  societyId: number,
  linkId: number,
  input: { email?: string; message?: string },
) {
  const { resident } = await memberLink(ctx, societyId, linkId);
  return inviteResident(ctx, societyId, resident.id!, input);
}

export async function saveMemberEmergency(
  ctx: Ctx,
  societyId: number,
  linkId: number,
  input: EmergencyInput,
) {
  const { resident } = await memberLink(ctx, societyId, linkId);
  if (resident.userId !== null)
    throw rule(422, 'MEMBER_HAS_LOGIN', 'This person manages their own emergency profile', 'linkId');
  return saveProfile(ctx, societyId, resident, input);
}
