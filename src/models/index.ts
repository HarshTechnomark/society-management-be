import { Op, Sequelize } from 'sequelize';
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
import { Plan } from './plan.model';
import { PlanVersion } from './plan-version.model';
import { PlanEntitlement } from './plan-entitlement.model';
import { Addon } from './addon.model';
import { Subscription } from './subscription.model';
import { SubscriptionAddon } from './subscription-addon.model';
import { EntitlementOverride } from './entitlement-override.model';
import { FeatureFlag } from './feature-flag.model';
import { FeatureFlagOverride } from './feature-flag-override.model';
import { UsageCounter } from './usage-counter.model';
import { SocietyLifecycleEvent } from './society-lifecycle-event.model';
import { SupportAccessGrant } from './support-access-grant.model';
import { SocietyNote } from './society-note.model';
import { DataExport } from './data-export.model';
import { NumberSequence } from './number-sequence.model';
import { PlatformInvoice } from './platform-invoice.model';
import { PlatformInvoiceLine } from './platform-invoice-line.model';
import { PlatformPayment } from './platform-payment.model';
import { PlatformCredit } from './platform-credit.model';
import { DunningEvent } from './dunning-event.model';
import { PlatformSetting } from './platform-setting.model';
import { PlatformTicket } from './platform-ticket.model';
import { PlatformTicketMessage } from './platform-ticket-message.model';
import { ServiceProvider } from './service-provider.model';
import { Incident } from './incident.model';
import { PlatformNotification } from './platform-notification.model';
import { Building } from './building.model';
import { Unit } from './unit.model';
import { SocietySetting } from './society-setting.model';
import { OnboardingStep } from './onboarding-step.model';
import { Holiday } from './holiday.model';
import { LocationNode } from './location-node.model';
import { Resident } from './resident.model';
import { UnitResident } from './unit-resident.model';
import { Tenancy } from './tenancy.model';
import { ResidentDocument } from './resident-document.model';
import { JoinRequest } from './join-request.model';
import { MoveRequest } from './move-request.model';
import { RenovationPermit } from './renovation-permit.model';
import { OwnershipTransfer } from './ownership-transfer.model';
import { Pet } from './pet.model';
import { EmergencyProfile } from './emergency-profile.model';

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
  Plan,
  PlanVersion,
  PlanEntitlement,
  Addon,
  Subscription,
  SubscriptionAddon,
  EntitlementOverride,
  FeatureFlag,
  FeatureFlagOverride,
  UsageCounter,
  SocietyLifecycleEvent,
  SupportAccessGrant,
  SocietyNote,
  DataExport,
  NumberSequence,
  PlatformInvoice,
  PlatformInvoiceLine,
  PlatformPayment,
  PlatformCredit,
  DunningEvent,
  PlatformSetting,
  PlatformTicket,
  PlatformTicketMessage,
  ServiceProvider,
  Incident,
  PlatformNotification,
  Building,
  Unit,
  SocietySetting,
  OnboardingStep,
  Holiday,
  LocationNode,
  Resident,
  UnitResident,
  Tenancy,
  ResidentDocument,
  JoinRequest,
  MoveRequest,
  RenovationPermit,
  OwnershipTransfer,
  Pet,
  EmergencyProfile,
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

// Module 04 associations (section 7)
Plan.hasMany(PlanVersion, { foreignKey: 'planId' });
Plan.belongsTo(PlanVersion, { as: 'currentVersion', foreignKey: 'currentVersionId', constraints: false });
PlanVersion.belongsTo(Plan, { foreignKey: 'planId' });
PlanVersion.hasMany(PlanEntitlement, { foreignKey: 'planVersionId' });
PlanEntitlement.belongsTo(PlanVersion, { foreignKey: 'planVersionId' });
Addon.hasMany(SubscriptionAddon, { foreignKey: 'addonId' });
Subscription.belongsTo(Society, { foreignKey: 'societyId' });
Subscription.belongsTo(Plan, { foreignKey: 'planId' });
Subscription.belongsTo(PlanVersion, { as: 'planVersion', foreignKey: 'planVersionId' });
Subscription.belongsTo(PlanVersion, { as: 'pendingPlanVersion', foreignKey: 'pendingPlanVersionId' });
Subscription.belongsTo(PlanVersion, {
  as: 'downgradedFromPlanVersion',
  foreignKey: 'downgradedFromPlanVersionId',
});
Subscription.hasMany(SubscriptionAddon, { foreignKey: 'subscriptionId' });
SubscriptionAddon.belongsTo(Subscription, { foreignKey: 'subscriptionId' });
SubscriptionAddon.belongsTo(Addon, { foreignKey: 'addonId' });
Society.hasOne(Subscription, {
  as: 'liveSubscription',
  foreignKey: 'societyId',
  scope: { status: { [Op.ne]: 'CANCELLED' } },
});
EntitlementOverride.belongsTo(Society, { foreignKey: 'societyId' });
FeatureFlag.hasMany(FeatureFlagOverride, { foreignKey: 'flagId' });
FeatureFlagOverride.belongsTo(FeatureFlag, { foreignKey: 'flagId' });
FeatureFlagOverride.belongsTo(Society, { foreignKey: 'societyId' });
UsageCounter.belongsTo(Society, { foreignKey: 'societyId' });

// Module 05 associations (section 7)
Society.hasMany(SocietyLifecycleEvent, { as: 'lifecycleEvents', foreignKey: 'societyId' });
SocietyLifecycleEvent.belongsTo(Society, { foreignKey: 'societyId' });
SocietyLifecycleEvent.belongsTo(User, { as: 'actor', foreignKey: 'actorUserId' });
Society.belongsTo(User, { as: 'creator', foreignKey: 'creatorUserId' });
SupportAccessGrant.belongsTo(Society, { foreignKey: 'societyId' });
SupportAccessGrant.belongsTo(User, { as: 'requester', foreignKey: 'platformUserId' });
SupportAccessGrant.belongsTo(User, { as: 'decidedBy', foreignKey: 'decidedByUserId' });
SupportAccessGrant.belongsTo(User, { as: 'endedBy', foreignKey: 'endedByUserId' });
SocietyNote.belongsTo(Society, { foreignKey: 'societyId' });
SocietyNote.belongsTo(User, { as: 'author', foreignKey: 'createdBy' });
DataExport.belongsTo(Society, { foreignKey: 'societyId' });
DataExport.belongsTo(User, { as: 'requestedBy', foreignKey: 'requestedByUserId' });

// Module 06 associations (section 7). `belongsTo(File, { as: 'pdf' })` waits for the module 01 files table.
Society.hasMany(PlatformInvoice, { foreignKey: 'societyId' });
PlatformInvoice.belongsTo(Society, { foreignKey: 'societyId' });
PlatformInvoice.belongsTo(Subscription, { foreignKey: 'subscriptionId' });
PlatformInvoice.hasMany(PlatformInvoiceLine, { as: 'lines', foreignKey: 'invoiceId' });
PlatformInvoice.hasMany(PlatformInvoice, { as: 'creditNotes', foreignKey: 'originalInvoiceId' });
PlatformInvoice.belongsTo(PlatformInvoice, { as: 'originalInvoice', foreignKey: 'originalInvoiceId' });
PlatformInvoice.hasMany(PlatformPayment, { as: 'payments', foreignKey: 'invoiceId' });
PlatformInvoice.hasMany(DunningEvent, { as: 'dunningEvents', foreignKey: 'invoiceId' });
PlatformInvoiceLine.belongsTo(PlatformInvoice, { as: 'invoice', foreignKey: 'invoiceId' });
PlatformInvoiceLine.belongsTo(PlanVersion, { as: 'planVersion', foreignKey: 'planVersionId' });
PlatformPayment.belongsTo(Society, { foreignKey: 'societyId' });
PlatformPayment.belongsTo(PlatformInvoice, { as: 'invoice', foreignKey: 'invoiceId' });
PlatformPayment.belongsTo(PlatformPayment, { as: 'sourcePayment', foreignKey: 'sourcePaymentId' });
PlatformPayment.hasMany(PlatformPayment, { as: 'refunds', foreignKey: 'sourcePaymentId' });
PlatformCredit.belongsTo(Society, { foreignKey: 'societyId' });
PlatformCredit.belongsTo(PlatformInvoice, { as: 'invoice', foreignKey: 'invoiceId' });
PlatformCredit.belongsTo(PlatformPayment, { as: 'payment', foreignKey: 'paymentId' });
DunningEvent.belongsTo(Society, { foreignKey: 'societyId' });
DunningEvent.belongsTo(PlatformInvoice, { as: 'invoice', foreignKey: 'invoiceId' });

// Module 07 associations (section 7)
PlatformTicket.belongsTo(Society, { foreignKey: 'societyId' });
PlatformTicket.belongsTo(User, { as: 'raisedBy', foreignKey: 'raisedByUserId' });
PlatformTicket.belongsTo(User, { as: 'assignee', foreignKey: 'assigneeUserId' });
PlatformTicket.hasMany(PlatformTicketMessage, { as: 'messages', foreignKey: 'ticketId' });
PlatformTicketMessage.belongsTo(PlatformTicket, { foreignKey: 'ticketId' });
PlatformTicketMessage.belongsTo(User, { as: 'author', foreignKey: 'authorUserId' });
ServiceProvider.hasMany(Incident, { foreignKey: 'serviceProviderId' });
Incident.belongsTo(ServiceProvider, { foreignKey: 'serviceProviderId' });
Incident.hasMany(PlatformNotification, { foreignKey: 'incidentId' });
PlatformNotification.belongsTo(Incident, { foreignKey: 'incidentId' });

// Module 08 associations (section 7)
Building.belongsTo(Society, { foreignKey: 'societyId' });
Building.belongsTo(Building, { as: 'parent', foreignKey: 'parentBuildingId' });
Building.hasMany(Building, { as: 'wings', foreignKey: 'parentBuildingId' });
Building.hasMany(Unit, { foreignKey: 'buildingId' });
Building.hasOne(LocationNode, {
  as: 'locationNode',
  foreignKey: 'buildingId',
  scope: { nodeType: 'BUILDING' },
});
Unit.belongsTo(Society, { foreignKey: 'societyId' });
Unit.belongsTo(Building, { foreignKey: 'buildingId' });
SocietySetting.belongsTo(Society, { foreignKey: 'societyId' });
OnboardingStep.belongsTo(Society, { foreignKey: 'societyId' });
Holiday.belongsTo(Society, { foreignKey: 'societyId' });
LocationNode.belongsTo(Society, { foreignKey: 'societyId' });
LocationNode.belongsTo(LocationNode, { as: 'parent', foreignKey: 'parentId' });
LocationNode.hasMany(LocationNode, { as: 'children', foreignKey: 'parentId' });
LocationNode.belongsTo(Building, { foreignKey: 'buildingId' });

// Module 09 associations (section 7)
Resident.belongsTo(Society, { foreignKey: 'societyId' });
Resident.belongsTo(User, { foreignKey: 'userId' });
Resident.belongsTo(SocietyMember, { as: 'member', foreignKey: 'memberId' });
Resident.belongsTo(Resident, { as: 'localRepresentative', foreignKey: 'localRepresentativeResidentId' });
Resident.hasMany(UnitResident, { foreignKey: 'residentId' });
Resident.hasOne(EmergencyProfile, { foreignKey: 'residentId' });
Resident.hasMany(ResidentDocument, { foreignKey: 'residentId' });
Resident.hasMany(Pet, { foreignKey: 'ownerResidentId' });
UnitResident.belongsTo(Resident, { foreignKey: 'residentId' });
UnitResident.belongsTo(Unit, { foreignKey: 'unitId' });
UnitResident.belongsTo(Tenancy, { foreignKey: 'tenancyId' });
UnitResident.belongsTo(OwnershipTransfer, { foreignKey: 'ownershipTransferId' });
Tenancy.belongsTo(Unit, { foreignKey: 'unitId' });
Tenancy.belongsTo(Resident, { as: 'tenant', foreignKey: 'tenantResidentId' });
Tenancy.belongsTo(Resident, { as: 'landlord', foreignKey: 'landlordResidentId' });
Tenancy.hasMany(UnitResident, { foreignKey: 'tenancyId' });
ResidentDocument.belongsTo(Resident, { foreignKey: 'residentId' });
ResidentDocument.belongsTo(Unit, { foreignKey: 'unitId' });
JoinRequest.belongsTo(User, { foreignKey: 'userId' });
JoinRequest.belongsTo(Unit, { foreignKey: 'unitId' });
JoinRequest.belongsTo(Resident, { as: 'confirmer', foreignKey: 'confirmerResidentId' });
JoinRequest.belongsTo(Resident, { foreignKey: 'residentId' });
MoveRequest.belongsTo(Unit, { foreignKey: 'unitId' });
MoveRequest.belongsTo(Tenancy, { foreignKey: 'tenancyId' });
MoveRequest.belongsTo(Resident, { as: 'requestedBy', foreignKey: 'requestedByResidentId' });
RenovationPermit.belongsTo(Unit, { foreignKey: 'unitId' });
RenovationPermit.belongsTo(Resident, { as: 'requestedBy', foreignKey: 'requestedByResidentId' });
OwnershipTransfer.belongsTo(Unit, { foreignKey: 'unitId' });
OwnershipTransfer.hasMany(UnitResident, { foreignKey: 'ownershipTransferId' });
OwnershipTransfer.belongsTo(Resident, { as: 'initiatedBy', foreignKey: 'initiatedByResidentId' });
Pet.belongsTo(Unit, { foreignKey: 'unitId' });
Pet.belongsTo(Resident, { as: 'owner', foreignKey: 'ownerResidentId' });
EmergencyProfile.belongsTo(Resident, { foreignKey: 'residentId' });

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
  Plan,
  PlanVersion,
  PlanEntitlement,
  Addon,
  Subscription,
  SubscriptionAddon,
  EntitlementOverride,
  FeatureFlag,
  FeatureFlagOverride,
  UsageCounter,
  SocietyLifecycleEvent,
  SupportAccessGrant,
  SocietyNote,
  DataExport,
  NumberSequence,
  PlatformInvoice,
  PlatformInvoiceLine,
  PlatformPayment,
  PlatformCredit,
  DunningEvent,
  PlatformSetting,
  PlatformTicket,
  PlatformTicketMessage,
  ServiceProvider,
  Incident,
  PlatformNotification,
  Building,
  Unit,
  SocietySetting,
  OnboardingStep,
  Holiday,
  LocationNode,
};

export async function closeDb(): Promise<void> {
  await sequelize.close();
}
