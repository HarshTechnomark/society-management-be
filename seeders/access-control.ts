import { Role, Society, SocietyMember, User, Invitation, sequelize } from '../src/models';
import { audit } from '../src/utils/audit';
import { systemCtx } from '../src/types/context';
import { users } from '../src/modules/auth/auth.public';
import { syncCatalogue, provisionSocietyRoles } from '../src/modules/access-control/access-control.public';
import { joinMember } from '../src/modules/access-control/access-control.members.service';
import {
  createInvitationCore,
  inviteLink,
  setupLink,
} from '../src/modules/access-control/access-control.invitations.service';
import { AUDIT } from '../src/modules/access-control/access-control.permissions';

/**
 * Module 03 seed section (spec 7.10): the catalogue and platform roles everywhere; roles, demo memberships, platform team and
 * the two pending invitations outside production. Idempotent. Needs the module 02 demo users and `demo-societies`.
 */
const PLATFORM_TEAM: { mobile: string; roleKey: string }[] = [
  { mobile: '9000000001', roleKey: 'super_admin' },
  { mobile: '9000000002', roleKey: 'platform_support' },
  { mobile: '9000000003', roleKey: 'super_admin' },
];

const DEMO_MEMBERS: { society: string; mobile: string; roleKey: string; label: string }[] = [
  { society: 'sky-heights', mobile: '9820011111', roleKey: 'chairman', label: 'A-501' },
  { society: 'sky-heights', mobile: '9820022222', roleKey: 'treasurer', label: 'B-302' },
  { society: 'sky-heights', mobile: '9820033333', roleKey: 'secretary', label: 'C-104' },
  { society: 'sky-heights', mobile: '9820044444', roleKey: 'facility_manager', label: 'Office' },
  { society: 'sky-heights', mobile: '9820055555', roleKey: 'society_admin', label: 'Office' },
  { society: 'green-park', mobile: '9820066666', roleKey: 'chairman', label: 'A-101' },
  { society: 'green-park', mobile: '9820077777', roleKey: 'treasurer', label: 'A-202' },
  { society: 'green-park', mobile: '9820011111', roleKey: 'secretary', label: 'B-203' },
];

export interface AccessSeedReport {
  catalogueAdded: number;
  rolesCreated: number;
  platformAssigned: string[];
  members: string[];
  invitations: Record<string, { inviteLink: string; setupLink?: string }>;
}

export async function seedAccessControl(opts: { demo: boolean }): Promise<AccessSeedReport> {
  const sync = await syncCatalogue();
  const report: AccessSeedReport = {
    catalogueAdded: sync.added,
    rolesCreated: sync.societyRolesCreated + sync.platformRoles,
    platformAssigned: [],
    members: [],
    invitations: {},
  };
  if (!opts.demo) return report;
  if (process.env.NODE_ENV === 'production') throw new Error('demo access data must not run in production');
  const ctx = systemCtx('seed');

  for (const s of await Society.findAll({ attributes: ['id'] }))
    await sequelize.transaction(async tx => {
      report.rolesCreated += await provisionSocietyRoles(s.id!, tx);
    });

  // platform team
  for (const p of PLATFORM_TEAM) {
    const u = await User.findOne({ where: { mobile: p.mobile } });
    const role = await Role.findOne({ where: { societyId: null, key: p.roleKey } });
    if (!u || !role || u.platformRoleId === role.id) continue;
    await sequelize.transaction(async tx => {
      const r = await users.setPlatformRole(tx, u.id!, role.id!);
      await audit(
        ctx,
        {
          action: AUDIT.platformMemberRoleChanged,
          entityType: 'user',
          entityId: u.id!,
          societyId: null,
          before: { roleId: r.before },
          after: { roleId: r.after },
          reason: 'Demo seed',
        },
        tx,
      );
    });
    report.platformAssigned.push(`${p.mobile} ${p.roleKey}`);
  }

  // society members
  for (const m of DEMO_MEMBERS) {
    const society = await Society.findOne({ where: { slug: m.society } });
    const user = await User.findOne({ where: { mobile: m.mobile } });
    if (!society || !user) continue;
    if (await SocietyMember.findOne({ where: { societyId: society.id!, userId: user.id! } })) continue;
    await sequelize.transaction(async tx => {
      const role = (await Role.findOne({
        where: { societyId: society.id!, key: m.roleKey },
        transaction: tx,
      }))!;
      const { member } = await joinMember(
        ctx,
        { societyId: society.id!, userId: user.id!, role, locationLabel: m.label },
        tx,
      );
      await audit(
        ctx,
        {
          action: AUDIT.memberJoined,
          entityType: 'society_member',
          entityId: member.id!,
          societyId: society.id!,
          after: { userId: user.id, roleKey: role.key },
        },
        tx,
      );
    });
    report.members.push(`${society.slug}: ${m.mobile} ${m.roleKey}`);
  }

  // pending invitations: Kavita Rao (Tulip Gardens, society admin) and Dev Malhotra (platform support)
  const pendings = [
    {
      key: 'kavita',
      societyId: (await Society.findOne({ where: { slug: 'tulip-gardens' } }))?.id ?? null,
      mobile: '9820088888',
      name: 'Kavita Rao',
      email: 'admin@tulipgardens.in',
      roleKey: 'society_admin',
      label: 'Office',
    },
    {
      key: 'dev',
      societyId: null,
      mobile: '9000000004',
      name: 'Dev Malhotra',
      email: 'dev.malhotra@societyapp.in',
      roleKey: 'platform_support',
      label: undefined,
    },
  ];
  for (const p of pendings) {
    if (p.key === 'kavita' && p.societyId === null) continue;
    if (await Invitation.findOne({ where: { societyId: p.societyId, mobile: p.mobile, status: 'PENDING' } }))
      continue;
    const r = await sequelize.transaction(tx =>
      createInvitationCore(
        ctx,
        {
          societyId: p.societyId,
          name: p.name,
          mobile: p.mobile,
          email: p.email,
          roleKey: p.roleKey,
          ...(p.label ? { locationLabel: p.label } : {}),
        },
        tx,
      ),
    );
    const scope = p.societyId === null ? 'platform' : 'society';
    report.invitations[p.name] = {
      inviteLink: inviteLink(scope, r.token),
      ...(r.setupToken ? { setupLink: setupLink(scope, r.setupToken) } : {}),
    };
  }
  return report;
}
