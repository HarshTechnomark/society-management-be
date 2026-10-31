import { Op } from 'sequelize';
import { Invitation, Role, Society, SocietyMember, User } from '../../models';
import { now } from '../../lib/clock';
import type { AuthPorts } from '../auth/auth.ports';
import type { ClientApp, MembershipView } from '../auth/auth.types';
import { computeAccess, getPlatformPermissionsOf } from './access-control.access';
import { deletionBlockers, onUserAnonymised } from './access-control.members.service';

/** The `authAccess` port module 02 consumes (BR-03-26, BR-03-29, BR-03-30, BR-03-31). Registered by `registerAccessControl()`. */
const SCOPE_OF_APP: Record<Exclude<ClientApp, 'PLATFORM' | 'RESIDENT'>, string> = {
  ADMIN: 'society',
  GATE: 'gate',
  WORK: 'work',
};

async function listMemberships(userId: number): Promise<MembershipView[]> {
  const members = (await SocietyMember.findAll({
    where: { userId, status: { [Op.in]: ['ACTIVE', 'SUSPENDED'] } },
    include: [
      { model: Role, required: true, paranoid: false },
      { model: Society, required: true },
    ],
    order: [['id', 'ASC']],
  })) as (SocietyMember & { Role: Role; Society: Society })[];
  const out: MembershipView[] = members.map(m => ({
    societyId: m.societyId,
    societyName: m.Society.name,
    city: m.Society.city,
    societyStatus: m.Society.status,
    memberId: m.id!,
    roleKey: m.Role.key,
    roleName: m.Role.name,
    roleScope: m.Role.scope as MembershipView['roleScope'],
    status: m.status,
  }));
  const invitations = (await Invitation.findAll({
    where: {
      invitedUserId: userId,
      status: 'PENDING',
      expiresAt: { [Op.gt]: now() },
      societyId: { [Op.ne]: null },
    },
    include: [
      { model: Role, required: true, paranoid: false },
      { model: Society, required: true },
    ],
    order: [['id', 'ASC']],
  })) as (Invitation & { Role: Role; Society: Society })[];
  for (const i of invitations)
    out.push({
      societyId: i.societyId!,
      societyName: i.Society.name,
      city: i.Society.city,
      societyStatus: i.Society.status,
      memberId: null,
      invitationId: i.id!,
      roleKey: i.Role.key,
      roleName: i.Role.name,
      roleScope: i.Role.scope as MembershipView['roleScope'],
      status: 'INVITED',
    });
  return out;
}

async function hasAppAccess(userId: number, app: ClientApp): Promise<boolean> {
  if (app === 'RESIDENT') return true;
  if (app === 'PLATFORM') {
    const u = await User.findByPk(userId, { attributes: ['id', 'platformRoleId'] });
    if (u?.platformRoleId) return true;
    return (
      (await Invitation.count({
        where: { invitedUserId: userId, societyId: null, status: 'PENDING', expiresAt: { [Op.gt]: now() } },
      })) > 0
    );
  }
  const scope = SCOPE_OF_APP[app];
  const member = await SocietyMember.count({
    where: { userId, status: 'ACTIVE' },
    include: [{ model: Role, required: true, where: { scope }, paranoid: false }],
  });
  if (member) return true;
  return (
    (await Invitation.count({
      where: {
        invitedUserId: userId,
        status: 'PENDING',
        expiresAt: { [Op.gt]: now() },
        societyId: { [Op.ne]: null },
      },
      include: [{ model: Role, required: true, where: { scope }, paranoid: false }],
    })) > 0
  );
}

async function userRequiresMfa(userId: number): Promise<boolean> {
  const u = await User.findByPk(userId, { attributes: ['id', 'platformRoleId'] });
  if (u?.platformRoleId) return true;
  return (
    (await SocietyMember.count({
      where: { userId, status: 'ACTIVE' },
      include: [{ model: Role, required: true, where: { requiresMfa: true }, paranoid: false }],
    })) > 0
  );
}

export const authAccess: AuthPorts['authAccess'] = {
  listMemberships,
  hasAppAccess,
  userRequiresMfa,
  getPermissions: async (userId, societyId) => (await computeAccess(societyId, userId)).permissions,
  getPlatformPermissions: getPlatformPermissionsOf,
  deletionBlockers,
  onUserAnonymised,
};
