import { Sequelize } from 'sequelize';
import { env } from '../lib/env';
import { User } from './user.model';
import { Session } from './session.model';
import { AuthOtp } from './auth-otp.model';
import { AuthToken } from './auth-token.model';
import { UserRecoveryCode } from './user-recovery-code.model';
import { UserPasskey } from './user-passkey.model';
import { AuthLockout } from './auth-lockout.model';
import { AuditLog } from './audit-log.model';
import { Organization } from './organization.model';
import { Society } from './society.model';
import { Permission } from './permission.model';
import { Role } from './role.model';
import { RolePermission } from './role-permission.model';
import { SocietyMember } from './society-member.model';
import { MemberGrant } from './member-grant.model';
import { Invitation } from './invitation.model';
import { IdempotencyKey } from './idempotency-key.model';

/** The one Sequelize connection. Each module adds its model file here and calls its `associate`. */
const u = new URL(env().DATABASE_URL);

export const sequelize = new Sequelize(
  u.pathname.replace(/^\//, ''),
  decodeURIComponent(u.username),
  decodeURIComponent(u.password),
  {
    host: u.hostname,
    port: Number(u.port || 3306),
    dialect: 'mysql',
    timezone: '+00:00',
    logging: false,
    pool: { max: 20, min: 0, idle: 10_000, acquire: 30_000 },
    define: { charset: 'utf8mb4', collate: 'utf8mb4_0900_ai_ci', freezeTableName: true },
  },
);

const models = {
  User,
  Session,
  AuthOtp,
  AuthToken,
  UserRecoveryCode,
  UserPasskey,
  AuthLockout,
  AuditLog,
  Organization,
  Society,
  Permission,
  Role,
  RolePermission,
  SocietyMember,
  MemberGrant,
  Invitation,
  IdempotencyKey,
};
for (const m of Object.values(models)) m.initModel(sequelize);

// Module 02 associations (section 7). Associations to File and Society are added by modules 01 and 05.
User.hasMany(Session, { foreignKey: 'userId' });
User.hasMany(AuthOtp, { foreignKey: 'userId' });
User.hasMany(AuthToken, { foreignKey: 'userId' });
User.hasMany(UserRecoveryCode, { foreignKey: 'userId' });
User.hasMany(UserPasskey, { foreignKey: 'userId' });
Session.belongsTo(User, { foreignKey: 'userId' });
AuthOtp.belongsTo(User, { foreignKey: 'userId' });
AuthOtp.belongsTo(Session, { foreignKey: 'sessionId' });
AuthToken.belongsTo(User, { foreignKey: 'userId' });
AuthToken.belongsTo(Session, { foreignKey: 'sessionId' });
UserRecoveryCode.belongsTo(User, { foreignKey: 'userId' });
UserPasskey.belongsTo(User, { foreignKey: 'userId' });
AuthLockout.belongsTo(User, { foreignKey: 'userId' });

// Module 01 and 03 associations (module 03 section 7)
Organization.hasMany(Society, { foreignKey: 'organizationId' });
Society.belongsTo(Organization, { foreignKey: 'organizationId' });
Role.belongsTo(Society, { foreignKey: 'societyId' });
Role.belongsToMany(Permission, { through: RolePermission, foreignKey: 'roleId', otherKey: 'permissionId' });
Permission.belongsToMany(Role, { through: RolePermission, foreignKey: 'permissionId', otherKey: 'roleId' });
Role.hasMany(RolePermission, { foreignKey: 'roleId' });
RolePermission.belongsTo(Role, { foreignKey: 'roleId' });
RolePermission.belongsTo(Permission, { foreignKey: 'permissionId' });
Role.hasMany(SocietyMember, { foreignKey: 'roleId' });
Role.hasMany(Invitation, { foreignKey: 'roleId' });
SocietyMember.belongsTo(Society, { foreignKey: 'societyId' });
SocietyMember.belongsTo(User, { foreignKey: 'userId' });
SocietyMember.belongsTo(Role, { foreignKey: 'roleId' });
SocietyMember.belongsTo(Invitation, { foreignKey: 'invitationId', constraints: false });
SocietyMember.hasMany(MemberGrant, { foreignKey: 'memberId' });
MemberGrant.belongsTo(SocietyMember, { as: 'member', foreignKey: 'memberId' });
MemberGrant.belongsTo(Permission, { foreignKey: 'permissionId' });
Permission.hasMany(MemberGrant, { foreignKey: 'permissionId' });
Invitation.belongsTo(Society, { foreignKey: 'societyId' });
Invitation.belongsTo(Role, { foreignKey: 'roleId' });
Invitation.belongsTo(User, { as: 'inviter', foreignKey: 'invitedBy', constraints: false });
User.belongsTo(Role, { as: 'platformRole', foreignKey: 'platformRoleId', constraints: false });

/** All models, filled in as modules add them. */
export const db = { sequelize, ...models };
export {
  User,
  Session,
  AuthOtp,
  AuthToken,
  UserRecoveryCode,
  UserPasskey,
  AuthLockout,
  AuditLog,
  Organization,
  Society,
  Permission,
  Role,
  RolePermission,
  SocietyMember,
  MemberGrant,
  Invitation,
  IdempotencyKey,
};

export async function closeDb(): Promise<void> {
  await sequelize.close();
}
