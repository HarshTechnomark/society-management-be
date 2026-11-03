import { Op, type Transaction } from 'sequelize';
import { Invitation, Resident, UnitResident, sequelize } from '../../models';
import type { Invitation as InvitationRow } from '../../models/invitation.model';
import { audit } from '../../utils/audit';
import { AppError } from '../../utils/errors';
import { logger } from '../../lib/logger';
import { systemCtx, type Ctx } from '../../types/context';
import { users } from '../auth/auth.public';
import { createInvitation, members } from '../access-control/access-control.public';
import { AUDIT, ENTITY, ROLE_KEY_OF } from './residents.constants';
import {
  isMinor,
  residentNotFound,
  rule,
  societyToday,
  strongestRelation,
  accessRelationOf,
} from './residents.shared';
import { syncMembership } from './residents.sync';

/** Invitations of residents to the app (BR-09-20, BR-09-21, 8.7, 8.24). Module 03 owns the invitation itself. */
export type InviteResult =
  | { mode: 'INVITED'; invitation: { id: number; status: string; expiresAt: string } }
  | { mode: 'LINKED'; memberId: number };

/** Inside the caller's transaction. `ctx` may be a system context (welcome invites). */
export async function inviteResidentTx(
  ctx: Ctx,
  societyId: number,
  residentId: number,
  input: { email?: string; message?: string },
  t: Transaction,
): Promise<InviteResult> {
  const r = await Resident.findOne({
    where: { id: residentId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!r) throw residentNotFound();
  const links = await UnitResident.findAll({
    where: { societyId, residentId, toDate: null },
    order: [['id', 'ASC']],
    transaction: t,
  });
  const inviteable = links.filter(l => l.canLogin);
  if (!r.mobile || !inviteable.length)
    throw rule(
      422,
      'INVITE_NOT_POSSIBLE',
      'To invite, the person needs a mobile number and a link to a flat that allows login',
      'residentId',
    );
  if (isMinor(r.dateOfBirth, await societyToday(societyId)) && !inviteable.length)
    throw rule(422, 'INVITE_NOT_POSSIBLE', 'A minor can be invited only when login is allowed', 'residentId');
  const [existing] = r.userId ? await members.listForSociety(societyId, { userIds: [r.userId] }) : [];
  if (existing?.status === 'ACTIVE')
    throw new AppError(409, 'ALREADY_LINKED', 'This person already has a login in the society');
  const email = input.email ?? r.email ?? undefined;
  const { userId } = await users.ensureInvitedUser(
    ctx,
    { mobile: r.mobile, name: r.name, ...(email ? { email } : {}) },
    t,
  );
  const other = await Resident.findOne({
    where: { societyId, userId, id: { [Op.ne]: residentId } },
    transaction: t,
  });
  if (other) throw new AppError(409, 'ALREADY_LINKED', 'This login already belongs to another resident');
  if (input.email && !r.email) {
    r.email = input.email.toLowerCase();
    r.version += 1;
  }
  const [m] = await members.listForSociety(societyId, { userIds: [userId] });
  if (m?.status === 'ACTIVE') {
    r.userId = userId;
    r.memberId = m.memberId;
    r.version += 1;
    await r.save({ transaction: t });
    await syncMembership(ctx, t, residentId, { societyId });
    await audit(
      ctx,
      {
        action: AUDIT.residentUserLinked,
        entityType: ENTITY.resident,
        entityId: residentId,
        societyId,
        after: { userId, memberId: m.memberId, via: 'INVITE' },
      },
      t,
    );
    return { mode: 'LINKED', memberId: m.memberId };
  }
  if (r.changed()) await r.save({ transaction: t });
  const strongest = strongestRelation(inviteable.map(l => l.relation));
  const link = inviteable.find(l => accessRelationOf(l.relation) === strongest) ?? inviteable[0]!;
  const inv = await createInvitation(
    ctx,
    {
      societyId,
      name: r.name,
      mobile: r.mobile,
      ...(email ? { email } : {}),
      roleKey: ROLE_KEY_OF[strongest],
      unitId: link.unitId,
      residentId,
      ...(input.message ? { message: input.message } : {}),
    },
    t,
  );
  await audit(
    ctx,
    {
      action: AUDIT.residentInvited,
      entityType: ENTITY.resident,
      entityId: residentId,
      societyId,
      after: { invitationId: inv.id, roleKey: ROLE_KEY_OF[strongest] },
    },
    t,
  );
  return {
    mode: 'INVITED',
    invitation: { id: inv.id!, status: inv.status, expiresAt: inv.expiresAt.toISOString() },
  };
}

export const inviteResident = (
  ctx: Ctx,
  societyId: number,
  residentId: number,
  input: { email?: string; message?: string },
): Promise<InviteResult> =>
  sequelize.transaction(t => inviteResidentTx(ctx, societyId, residentId, input, t));

// ------------------------------------------------------------------ module 03 hook (BR-09-21)
/** `residents.onResidentInvitationAccepted(tx, invitation, userId)`: runs in module 03's accept transaction. */
export async function onResidentInvitationAccepted(
  tx: Transaction,
  invitation: InvitationRow,
  userId: number,
): Promise<void> {
  if (invitation.residentId === null || invitation.societyId === null) return;
  const societyId = invitation.societyId;
  const r = await Resident.findOne({
    where: { id: invitation.residentId, societyId },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  if (!r) return; // deleted since the invitation went out; the membership stays
  const other = await Resident.findOne({
    where: { societyId, userId, id: { [Op.ne]: r.id! } },
    transaction: tx,
  });
  if (other)
    throw new AppError(
      409,
      'ALREADY_LINKED',
      'This login already belongs to another resident of the society',
    );
  r.userId = userId;
  r.memberId = invitation.acceptedMemberId;
  r.version += 1;
  await r.save({ transaction: tx });
  const ctx: Ctx = { requestId: 'module-03', ip: '', userAgent: '' };
  await syncMembership(ctx, tx, r.id!, { societyId });
  await audit(
    ctx,
    {
      action: AUDIT.residentUserLinked,
      entityType: ENTITY.resident,
      entityId: r.id!,
      societyId,
      after: { userId, memberId: invitation.acceptedMemberId, via: 'INVITATION' },
      actor: { userId, name: r.name, role: 'user' },
    },
    tx,
  );
}

// ------------------------------------------------------------------ go-live welcome invites (BR-09-79, 8.24)
const BATCH = 100;
const SKIP_CODES = new Set([
  'INVITATION_ALREADY_PENDING',
  'EMAIL_IN_USE',
  'ACCOUNT_DISABLED',
  'MEMBER_SUSPENDED',
  'ALREADY_LINKED',
  'ALREADY_MEMBER',
  'INVITE_NOT_POSSIBLE',
]);

export async function sendWelcomeInvites(
  ctx: Ctx,
  societyId: number,
): Promise<{ invited: number; linked: number; skipped: number }> {
  const out = { invited: 0, linked: 0, skipped: 0 };
  const today = await societyToday(societyId);
  const pending = new Set(
    (
      await Invitation.findAll({
        where: { societyId, status: 'PENDING' },
        attributes: ['residentId', 'mobile'],
      })
    ).flatMap(i => [`r${i.residentId}`, `m${i.mobile}`]),
  );
  let last = 0;
  for (;;) {
    const batch = await Resident.findAll({
      where: { societyId, status: 'ACTIVE', mobile: { [Op.ne]: null }, id: { [Op.gt]: last } },
      order: [['id', 'ASC']],
      limit: BATCH,
    });
    if (!batch.length) break;
    last = batch[batch.length - 1]!.id!;
    for (const r of batch) {
      if (pending.has(`r${r.id}`) || pending.has(`m${r.mobile}`) || isMinor(r.dateOfBirth, today)) continue;
      const hasLink = await UnitResident.count({
        where: { societyId, residentId: r.id!, toDate: null, canLogin: true },
      });
      if (!hasLink) continue;
      if (r.userId) {
        const [m] = await members.listForSociety(societyId, { userIds: [r.userId] });
        if (m) continue; // already a member (or suspended): nothing to invite
      }
      try {
        const res = await sequelize.transaction(t => inviteResidentTx(ctx, societyId, r.id!, {}, t));
        if (res.mode === 'INVITED') out.invited += 1;
        else out.linked += 1;
      } catch (err) {
        const code = (err as { code?: string }).code ?? '';
        if (!SKIP_CODES.has(code)) logger.error({ err, residentId: r.id }, 'welcome invite failed');
        out.skipped += 1;
      }
    }
  }
  await sequelize.transaction(t =>
    audit(
      ctx.user ? ctx : systemCtx(ctx.requestId),
      {
        action: AUDIT.welcomeInvitesSent,
        entityType: ENTITY.resident,
        entityId: societyId,
        societyId,
        after: out,
      },
      t,
    ),
  );
  return out;
}
