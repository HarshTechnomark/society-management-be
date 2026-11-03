import { PET_SPECIES } from '../../models/pet.model';

/** Names, enums and keys of module 09 (sections 2.2, 5, 7 and 9). The enums are shared with Zod. */
export const RESIDENTS_QUEUE = 'residents';
export const JOBS = {
  syncLinks: 'residents:sync-links',
  petReminders: 'residents:pet-reminders',
  import: 'residents:import',
  welcomeInvites: 'residents:welcome-invites',
} as const;

/** Entitlement keys of section 2.2 (module 04 catalogue). */
export const FEATURE = {
  registry: 'residents.person_registry',
  ownership: 'residents.ownership_records',
  jointOwnership: 'residents.joint_ownership',
  tenancies: 'residents.tenancies',
  occupancy: 'residents.occupancy_records',
  family: 'residents.family_members',
  invitations: 'residents.invitation_and_self_registration',
  bulkImport: 'residents.bulk_import',
  kyc: 'residents.kyc_vault',
  timeline: 'residents.resident_timeline',
  duplicates: 'residents.duplicate_person_detection',
  portfolio: 'residents.owner_portfolio_view',
  analytics: 'residents.occupancy_analytics',
  directory: 'residents.resident_directory',
  emergency: 'residents.emergency_profile',
  pets: 'residents.pets_registry',
  careFlags: 'residents.care_flags',
  welcomeKit: 'residents.welcome_kit',
  nri: 'residents.nri_and_absentee_owner_support',
} as const;

export const ENTITY = {
  resident: 'resident',
  link: 'unit_resident',
  unit: 'unit',
  document: 'resident_document',
  import: 'resident_import',
  pet: 'pet',
  emergency: 'emergency_profile',
  sos: 'sos',
} as const;

/** Section 9.2 (the actions of parts 2 and 3 are listed here so that every part uses the same strings). */
export const AUDIT = {
  residentCreated: 'residents.resident.created',
  residentUpdated: 'residents.resident.updated',
  residentDeleted: 'residents.resident.deleted',
  residentInvited: 'residents.resident.invited',
  residentUserLinked: 'residents.resident.user_linked',
  contactsRevealed: 'residents.resident.contacts_revealed',
  residentExported: 'residents.resident.exported',
  mobileSynced: 'residents.resident.mobile_synced',
  residentAnonymised: 'residents.resident.anonymised',
  linkCreated: 'residents.link.created',
  linkUpdated: 'residents.link.updated',
  linkEnded: 'residents.link.ended',
  sharesUpdated: 'residents.link.shares_updated',
  unitVacated: 'residents.unit.vacated',
  documentUploaded: 'residents.document.uploaded',
  documentVerified: 'residents.document.verified',
  documentRejected: 'residents.document.rejected',
  documentDeleted: 'residents.document.deleted',
  documentDownloaded: 'residents.document.downloaded',
  importStarted: 'residents.import.started',
  importCompleted: 'residents.import.completed',
  petCreated: 'residents.pet.created',
  petUpdated: 'residents.pet.updated',
  petDeleted: 'residents.pet.deleted',
  emergencyUpdated: 'residents.emergency_profile.updated',
  emergencyConsentWithdrawn: 'residents.emergency_profile.consent_withdrawn',
  emergencyViewed: 'residents.emergency_profile.viewed',
  privacyUpdated: 'residents.privacy.updated',
  welcomeInvitesSent: 'residents.welcome_invites.sent',
} as const;

// ------------------------------------------------------------------ resident and link vocabulary
export const GENDERS = ['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED'] as const;
export const RESIDENT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export const HOUSEHOLDS = ['OWNER', 'TENANT'] as const;
export type Household = (typeof HOUSEHOLDS)[number];
export const OWNER_RELATIONS = ['OWNER', 'CO_OWNER'] as const;
/** Link end reasons an admin may choose (`TENANCY_ENDED` and `TERMINATED` are system-only, 8.8). */
export const MANUAL_END_REASONS = [
  'MOVED_OUT',
  'SOLD',
  'TRANSFERRED',
  'DECEASED',
  'CORRECTION',
  'REMOVED',
  'OTHER',
] as const;
/** The module 03 relation a unit-link relation maps to (BR-09-8). */
export type AccessRelation = 'OWNER' | 'TENANT' | 'FAMILY';
export const RELATION_RANK: Record<AccessRelation, number> = { OWNER: 3, TENANT: 2, FAMILY: 1 };
export const ROLE_KEY_OF: Record<AccessRelation, string> = {
  OWNER: 'owner',
  TENANT: 'tenant',
  FAMILY: 'family_member',
};
export const KYC_STATUSES = ['NONE', 'PENDING', 'VERIFIED', 'REJECTED'] as const;
export const OCCUPANCIES = ['OWNER_OCCUPIED', 'RENTED', 'VACANT'] as const;
export type Occupancy = (typeof OCCUPANCIES)[number];

// ------------------------------------------------------------------ documents (BR-09-37)
export const ID_DOC_TYPES = [
  'AADHAAR',
  'PAN',
  'PASSPORT',
  'DRIVING_LICENCE',
  'VOTER_ID',
  'OTHER_ID',
] as const;
export const KYC_DOC_TYPES = [...ID_DOC_TYPES, 'ADDRESS_PROOF'] as const;
export const DOC_TYPES = [
  ...KYC_DOC_TYPES,
  'RENT_AGREEMENT',
  'POLICE_VERIFICATION',
  'SALE_DEED',
  'INDEX_II',
  'STAMP_DUTY_RECEIPT',
  'ORIGINAL_SHARE_CERTIFICATE',
  'MEMBERSHIP_APPLICATION',
  'NOC',
  'DEATH_CERTIFICATE',
  'SUCCESSION_CERTIFICATE',
  'CONTRACTOR_ID',
  'WORK_PLAN',
  'STRUCTURAL_CERTIFICATE',
  'VACCINATION_CERTIFICATE',
  'OTHER',
] as const;
export type DocType = (typeof DOC_TYPES)[number];
/** What residents may upload on `/me/documents` (8.11). */
export const SELF_DOC_TYPES = [...ID_DOC_TYPES, 'ADDRESS_PROOF', 'OTHER'] as const;
export const DOC_REF_TYPES = [
  'tenancy',
  'move_request',
  'renovation_permit',
  'ownership_transfer',
  'join_request',
  'pet',
] as const;
export type DocRefType = (typeof DOC_REF_TYPES)[number];
export const isKycDoc = (t: string): boolean => (KYC_DOC_TYPES as readonly string[]).includes(t);
export const isIdDoc = (t: string): boolean => (ID_DOC_TYPES as readonly string[]).includes(t);

export { PET_SPECIES };
export const PET_GENDERS = ['MALE', 'FEMALE', 'UNKNOWN'] as const;
export const PET_INACTIVE_REASONS = ['MOVED_OUT', 'DECEASED', 'REHOMED', 'OTHER'] as const;
export const PET_VACCINATION_FILTERS = ['EXPIRED', 'EXPIRING_30', 'VALID', 'NONE'] as const;

export const EMERGENCY_CONSENT_VERSION = 'v1';
export const IMPORT_MAX_ROWS = 5000;
export const EXPORT_MAX_ROWS = 20_000;
export const UNIT_FILTER_LIMIT = 3000;
export const LIVE_TENANCY = ['APPROVED', 'ACTIVE', 'EXPIRED_OVERSTAY'] as const;
export const OPEN_MOVE_STATUSES = [
  'PENDING_OWNER',
  'BLOCKED_DUES',
  'PENDING_DEPOSIT',
  'PENDING_APPROVAL',
  'APPROVED',
  'IN_PROGRESS',
] as const;
export const OPEN_PERMIT_STATUSES = [
  'PENDING_DEPOSIT',
  'PENDING_APPROVAL',
  'APPROVED',
  'IN_PROGRESS',
  'SUSPENDED',
  'INSPECTION_PENDING',
] as const;
export const OPEN_TRANSFER_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] as const;
export const OPEN_JOIN_STATUSES = ['PENDING_OWNER', 'PENDING_ADMIN'] as const;
