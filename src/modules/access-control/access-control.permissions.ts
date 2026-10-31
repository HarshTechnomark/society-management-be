import type { PermissionAction, PermissionScope } from '../../models/permission.model';

/**
 * Permission catalogue, default role matrix and the lists module 03 needs (spec sections 5.1, 7.7, 7.8, 7.9, BR-03-16).
 * This file is the single source of truth: the seeder (`access-control.seed.ts`) upserts it into `permissions`.
 */
export type Scope = PermissionScope;
export type A = PermissionAction;
export type CatalogueRow = [subMaster: string, actions: A[], moduleNo: number, label: string];

export const SCOPES: Scope[] = ['platform', 'society', 'resident', 'gate', 'work'];
export const ACTIONS: A[] = ['view', 'create', 'edit', 'delete', 'import', 'export', 'approve'];
export const KEY_PATTERN = /^[a-z_]+\.[a-z_]+\.(view|create|edit|delete|import|export|approve)$/;

export const CATALOGUE: Record<Scope, CatalogueRow[]> = {
  platform: [
    ['platform.dashboard', ['view'], 7, 'Platform overview'],
    ['platform.societies', ['view', 'create', 'edit', 'delete', 'export', 'approve'], 5, 'Societies'],
    ['platform.support_access', ['view', 'create', 'approve'], 5, 'Support access'],
    ['platform.plans', ['view', 'create', 'edit', 'approve'], 4, 'Plans and add-ons'],
    ['platform.feature_flags', ['view', 'create', 'edit'], 4, 'Feature flags'],
    ['platform.billing', ['view', 'edit', 'export', 'approve'], 6, 'Platform billing'],
    ['platform.jobs', ['view', 'edit'], 7, 'Jobs and queues'],
    ['platform.tickets', ['view', 'create', 'edit'], 7, 'Support tickets'],
    ['platform.health', ['view', 'edit'], 7, 'Platform health'],
    ['platform.announcements', ['view', 'create', 'edit'], 7, 'Announcements'],
    ['platform.team', ['view', 'create', 'edit', 'delete'], 3, 'Platform team'],
    ['platform.audit_log', ['view', 'export'], 7, 'Platform audit trail'],
    ['platform.settings', ['view', 'edit'], 7, 'Platform settings'],
  ],
  society: [
    ['dashboard.today', ['view'], 24, 'Today dashboard'],
    ['approvals.inbox', ['view'], 14, 'Approvals inbox'],
    [
      'finance.billing',
      ['view', 'create', 'edit', 'delete', 'import', 'export', 'approve'],
      11,
      'Billing and invoices',
    ],
    ['finance.payments', ['view', 'create', 'edit', 'export', 'approve'], 12, 'Payments and receipts'],
    ['finance.collections', ['view', 'create', 'edit', 'delete', 'export', 'approve'], 12, 'Collections'],
    [
      'finance.expenses',
      ['view', 'create', 'edit', 'delete', 'export', 'approve'],
      13,
      'Expenses and cash book',
    ],
    ['finance.accounts', ['view', 'create', 'edit', 'export', 'approve'], 13, 'Society balance and accounts'],
    ['finance.bank', ['view', 'edit', 'import', 'approve'], 13, 'Bank and reconciliation'],
    ['residents.units', ['view', 'create', 'edit', 'delete', 'import', 'export'], 8, 'Flats'],
    ['residents.people', ['view', 'create', 'edit', 'delete', 'import', 'export', 'approve'], 9, 'Residents'],
    ['residents.contacts', ['view'], 9, 'Unmasked phones and emails'],
    ['residents.requests', ['view', 'create', 'edit', 'approve'], 9, 'Resident requests'],
    [
      'helpdesk.tickets',
      ['view', 'create', 'edit', 'delete', 'export'],
      15,
      'Complaints and building issues',
    ],
    ['helpdesk.settings', ['view', 'edit'], 15, 'Helpdesk settings'],
    ['communication.notices', ['view', 'create', 'edit', 'delete', 'approve'], 16, 'Notices'],
    ['communication.emergency', ['create'], 16, 'Emergency alerts'],
    ['communication.surveys', ['view', 'create', 'edit', 'export'], 16, 'Surveys'],
    ['security.visitors', ['view', 'edit', 'export'], 17, 'Visitors and deliveries'],
    ['security.guards', ['view', 'create', 'edit', 'delete'], 17, 'Guards, devices and patrol'],
    ['security.incidents', ['view', 'edit'], 17, 'SOS and incidents'],
    ['security.access_cards', ['view', 'create', 'edit', 'delete'], 17, 'Access cards and keys'],
    ['amenities.amenities', ['view', 'create', 'edit', 'delete'], 18, 'Amenities'],
    ['amenities.bookings', ['view', 'create', 'edit', 'export', 'approve'], 18, 'Bookings'],
    ['parking.slots', ['view', 'create', 'edit', 'delete', 'approve'], 19, 'Parking slots'],
    ['parking.vehicles', ['view', 'create', 'edit', 'delete', 'export'], 19, 'Vehicles'],
    ['parking.violations', ['view', 'create', 'edit', 'approve'], 19, 'Parking violations'],
    ['staff.society_staff', ['view', 'create', 'edit', 'delete'], 20, 'Society staff'],
    ['staff.domestic_help', ['view', 'create', 'edit', 'delete', 'approve'], 20, 'Domestic help'],
    ['staff.attendance', ['view', 'edit', 'export'], 20, 'Staff attendance'],
    ['vendors.vendors', ['view', 'create', 'edit', 'delete'], 21, 'Vendors'],
    ['vendors.purchase_orders', ['view', 'create', 'edit', 'approve'], 21, 'Purchase orders'],
    ['vendors.assets', ['view', 'create', 'edit', 'delete'], 21, 'Assets and maintenance'],
    ['governance.meetings', ['view', 'create', 'edit', 'approve'], 22, 'Meetings'],
    ['governance.polls', ['view', 'create', 'edit', 'approve'], 22, 'Polls'],
    ['governance.elections', ['view', 'create', 'edit', 'approve'], 22, 'Elections'],
    ['documents.documents', ['view', 'create', 'edit', 'delete'], 23, 'Documents'],
    ['documents.registers', ['view', 'edit', 'export'], 23, 'Statutory registers'],
    ['documents.compliance', ['view', 'create', 'edit'], 23, 'Compliance calendar'],
    ['documents.rules', ['view', 'create', 'edit', 'approve'], 23, 'Rule book and fines'],
    ['documents.certificates', ['view', 'create', 'approve'], 23, 'Certificates'],
    ['community.posts', ['view', 'edit', 'delete', 'approve'], 26, 'Community posts'],
    ['community.events', ['view', 'create', 'edit', 'delete'], 26, 'Community events'],
    ['reports.reports', ['view', 'export'], 24, 'Reports'],
    ['settings.society', ['view', 'edit'], 8, 'Society profile'],
    ['settings.members', ['view', 'create', 'edit', 'delete', 'export'], 3, 'Committee and team'],
    ['settings.roles', ['view', 'create', 'edit', 'delete'], 3, 'Roles'],
    ['settings.billing_rules', ['view', 'edit'], 11, 'Billing rules'],
    ['settings.approval_rules', ['view', 'edit'], 14, 'Approval rules'],
    ['settings.integrations', ['view', 'edit', 'approve'], 29, 'Integrations'],
    ['settings.subscription', ['view', 'edit'], 4, 'Subscription'],
    ['settings.audit_log', ['view', 'export'], 7, 'Audit trail'],
    ['settings.support_access', ['view', 'approve'], 5, 'Support access requests'],
    ['settings.data_export', ['view', 'create'], 5, 'Data export'],
    ['settings.support', ['view', 'create'], 7, 'Support tickets'],
    ['ai.assistant', ['view', 'create'], 30, 'AI assistant'],
    ['ai.copilot', ['create'], 30, 'AI copilot drafts'],
    ['ai.settings', ['view', 'edit'], 30, 'AI settings'],
    ['ai.usage', ['view', 'export'], 30, 'AI usage'],
    ['ai.conversations', ['view', 'delete'], 30, 'AI conversations review'],
    ['automation.rules', ['view', 'create', 'edit', 'delete', 'approve'], 30, 'Automation rules'],
  ],
  resident: [
    ['resident.home', ['view'], 25, 'Home'],
    ['resident.dues', ['view'], 11, 'Dues and statement'],
    ['resident.payments', ['view', 'create'], 12, 'Pay and receipts'],
    ['resident.household', ['view', 'create', 'edit', 'delete'], 9, 'Household'],
    ['resident.visitors', ['view', 'create', 'approve'], 17, 'Visitors'],
    ['resident.helpdesk', ['view', 'create', 'edit'], 15, 'Help'],
    ['resident.notices', ['view', 'edit'], 16, 'Notices'],
    ['resident.amenities', ['view', 'create'], 18, 'Amenity bookings'],
    ['resident.polls', ['view', 'create'], 22, 'Polls and voting'],
    ['resident.community', ['view', 'create'], 26, 'Community'],
    ['resident.documents', ['view', 'create'], 23, 'Documents and certificates'],
    ['resident.requests', ['view', 'create'], 9, 'Requests'],
    ['resident.finances', ['view'], 13, 'Society finances'],
    ['resident.assistant', ['view', 'create'], 30, 'Assistant'],
  ],
  gate: [
    ['gate.visitors', ['view', 'create', 'edit'], 17, 'Gate visitors'],
    ['gate.deliveries', ['view', 'create', 'edit'], 17, 'Gate deliveries'],
    ['gate.vehicles', ['view', 'create'], 19, 'Vehicle lookup and guest parking'],
    ['gate.patrol', ['view', 'create'], 17, 'Patrol'],
    ['gate.sos', ['create'], 17, 'SOS'],
    ['gate.staff_entry', ['create'], 20, 'Staff entry'],
    ['gate.amenities', ['view', 'edit'], 18, 'Amenity check-in'],
    ['gate.building_issues', ['create'], 15, 'Report a building issue'],
  ],
  work: [
    ['work.tasks', ['view', 'edit'], 28, 'My tasks'],
    ['work.attendance', ['create'], 20, 'Attendance'],
    ['work.checklists', ['view', 'edit'], 28, 'Checklists'],
    ['work.building_issues', ['create'], 15, 'Report a building issue'],
  ],
};

export interface PermissionDef {
  key: string;
  scope: Scope;
  master: string;
  subMaster: string;
  action: A;
  label: string;
  moduleNo: number;
  isPrivileged: boolean;
  sortOrder: number;
}

const VERB: Record<A, string> = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  import: 'Import',
  export: 'Export',
  approve: 'Approve',
};

/** Section 5.1: which keys are privileged (they force `roles.requiresMfa` on custom roles). */
export function isPrivilegedKey(key: string, scope: Scope): boolean {
  const action = key.slice(key.lastIndexOf('.') + 1);
  if (scope === 'platform') return true;
  if (scope === 'society') {
    if (key.startsWith('finance.') && action !== 'view') return true;
    if (action === 'import' || action === 'export') return true;
    if (['settings.roles.create', 'settings.roles.edit', 'settings.roles.delete'].includes(key)) return true;
    if (['settings.members.create', 'settings.members.edit', 'settings.members.delete'].includes(key))
      return true;
    return [
      'settings.integrations.edit',
      'settings.subscription.edit',
      'settings.billing_rules.edit',
      'settings.approval_rules.edit',
      'settings.support_access.approve',
      'settings.data_export.create',
      'residents.contacts.view',
    ].includes(key);
  }
  return false;
}

/** Expands the catalogue into one definition per key, in catalogue order (the role editor order). */
export function expandCatalogue(): PermissionDef[] {
  const out: PermissionDef[] = [];
  let sortOrder = 0;
  for (const scope of SCOPES) {
    for (const [subMaster, actions, moduleNo, label] of CATALOGUE[scope]) {
      const master = subMaster.slice(0, subMaster.indexOf('.'));
      const sub = subMaster.slice(subMaster.indexOf('.') + 1);
      for (const action of actions) {
        const key = `${subMaster}.${action}`;
        out.push({
          key,
          scope,
          master,
          subMaster: sub,
          action,
          label: `${VERB[action]} ${label.charAt(0).toLowerCase()}${label.slice(1)}`,
          moduleNo,
          isPrivileged: isPrivilegedKey(key, scope),
          sortOrder: sortOrder++,
        });
      }
    }
  }
  return out;
}

export const ALL_DEFS: PermissionDef[] = expandCatalogue();
export const DEF_BY_KEY: ReadonlyMap<string, PermissionDef> = new Map(ALL_DEFS.map(d => [d.key, d]));
export const keysOfScope = (scope: Scope): string[] =>
  ALL_DEFS.filter(d => d.scope === scope).map(d => d.key);
export const isKnownKey = (key: string): boolean => DEF_BY_KEY.has(key);

// ------------------------------------------------------------------ roles (7.8)
export interface SystemRoleDef {
  key: string;
  name: string;
  scope: Scope;
  requiresMfa: boolean;
  consumesSeat: boolean;
  description: string;
}

export const DEFAULT_SOCIETY_ROLES: SystemRoleDef[] = [
  {
    key: 'chairman',
    name: 'Chairman',
    scope: 'society',
    requiresMfa: true,
    consumesSeat: false,
    description: 'Heads the committee and holds every society permission',
  },
  {
    key: 'secretary',
    name: 'Secretary',
    scope: 'society',
    requiresMfa: true,
    consumesSeat: false,
    description: 'Runs the day-to-day work of the society',
  },
  {
    key: 'treasurer',
    name: 'Treasurer',
    scope: 'society',
    requiresMfa: true,
    consumesSeat: false,
    description: 'Keeps the money: collections, payments, expenses and accounts',
  },
  {
    key: 'committee_member',
    name: 'Committee Member',
    scope: 'society',
    requiresMfa: false,
    consumesSeat: false,
    description: 'Elected member who views most things and helps with decisions',
  },
  {
    key: 'society_admin',
    name: 'Society Admin',
    scope: 'society',
    requiresMfa: true,
    consumesSeat: true,
    description: 'Paid office staff who run the society office',
  },
  {
    key: 'accountant',
    name: 'Accountant',
    scope: 'society',
    requiresMfa: true,
    consumesSeat: true,
    description: 'Keeps the books and records payments',
  },
  {
    key: 'facility_manager',
    name: 'Facility Manager',
    scope: 'society',
    requiresMfa: false,
    consumesSeat: true,
    description: 'Looks after the building, amenities, vendors and assets',
  },
  {
    key: 'security_supervisor',
    name: 'Security Supervisor',
    scope: 'society',
    requiresMfa: false,
    consumesSeat: true,
    description: 'Leads the guards and handles incidents',
  },
  {
    key: 'auditor',
    name: 'Auditor',
    scope: 'society',
    requiresMfa: false,
    consumesSeat: true,
    description: 'Reads finances and records for the audit',
  },
  {
    key: 'guard',
    name: 'Security Guard',
    scope: 'gate',
    requiresMfa: false,
    consumesSeat: false,
    description: 'Works at the gate',
  },
  {
    key: 'maintenance_staff',
    name: 'Maintenance Staff',
    scope: 'work',
    requiresMfa: false,
    consumesSeat: false,
    description: 'Does assigned maintenance work',
  },
  {
    key: 'vendor',
    name: 'Vendor',
    scope: 'work',
    requiresMfa: false,
    consumesSeat: false,
    description: 'External vendor with assigned work',
  },
  {
    key: 'owner',
    name: 'Owner',
    scope: 'resident',
    requiresMfa: false,
    consumesSeat: false,
    description: 'Owns a flat',
  },
  {
    key: 'tenant',
    name: 'Tenant',
    scope: 'resident',
    requiresMfa: false,
    consumesSeat: false,
    description: 'Rents a flat',
  },
  {
    key: 'family_member',
    name: 'Family Member',
    scope: 'resident',
    requiresMfa: false,
    consumesSeat: false,
    description: 'Lives in a flat of an owner or tenant',
  },
];

export const COMMITTEE_ROLE_KEYS = ['chairman', 'secretary', 'treasurer', 'committee_member'] as const;
export const OFFICE_BEARER_KEYS = ['chairman', 'secretary', 'treasurer'] as const;

export const PLATFORM_ROLES: SystemRoleDef[] = [
  {
    key: 'super_admin',
    name: 'Super Admin',
    scope: 'platform',
    requiresMfa: true,
    consumesSeat: false,
    description: 'Runs the whole platform',
  },
  {
    key: 'platform_support',
    name: 'Platform Support',
    scope: 'platform',
    requiresMfa: true,
    consumesSeat: false,
    description: 'Helps societies, can view most of the platform',
  },
];

const platformKeys = keysOfScope('platform');
export const PLATFORM_ROLE_PERMISSIONS: Record<string, string[]> = {
  super_admin: platformKeys,
  platform_support: [
    ...platformKeys.filter(k => k.endsWith('.view')),
    'platform.societies.create',
    'platform.support_access.create',
    'platform.tickets.create',
    'platform.tickets.edit',
  ],
};

// ------------------------------------------------------------------ default matrix (7.9)
const LETTER: Record<string, A> = {
  V: 'view',
  C: 'create',
  E: 'edit',
  D: 'delete',
  I: 'import',
  X: 'export',
  A: 'approve',
};
const SOCIETY_ROLE_ORDER = [
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
const RESIDENT_ROLE_ORDER = [
  'owner',
  'tenant',
  'family_member',
  'guard',
  'maintenance_staff',
  'vendor',
] as const;

/** Cell: `All`, empty (none) or letters (V view, C create, E edit, D delete, I import, X export, A approve). */
type Cell = string;
const SOCIETY_MATRIX: [string, Cell[]][] = [
  ['dashboard.today', ['All', 'All', 'All', 'All', 'All', 'All', 'All', 'All', 'All']],
  ['approvals.inbox', ['All', 'All', 'All', 'All', 'All', '', 'All', '', '']],
  ['finance.billing', ['All', 'VA', 'All', 'V', 'V', 'VCEIX', '', '', 'VX']],
  ['finance.payments', ['All', 'VA', 'All', 'V', 'VC', 'VCEX', '', '', 'VX']],
  ['finance.collections', ['All', 'VCE', 'All', 'V', 'V', 'VX', '', '', 'VX']],
  ['finance.expenses', ['All', 'VA', 'All', 'V', 'VC', 'VCEX', 'VC', '', 'VX']],
  ['finance.accounts', ['All', 'VA', 'All', 'V', 'V', 'VCEX', '', '', 'VX']],
  ['finance.bank', ['All', '', 'All', '', '', 'VI', '', '', 'V']],
  ['residents.units', ['All', 'All', 'V', 'V', 'All', 'V', 'V', 'V', 'V']],
  ['residents.people', ['All', 'All', 'V', 'V', 'VCEDIX', 'V', 'V', 'V', 'V']],
  ['residents.contacts', ['All', 'All', 'All', '', 'All', '', 'All', 'All', '']],
  ['residents.requests', ['All', 'All', 'V', 'V', 'All', '', 'VE', 'V', '']],
  ['helpdesk.tickets', ['All', 'All', 'VC', 'VC', 'All', 'V', 'All', 'VC', '']],
  ['helpdesk.settings', ['All', 'All', '', '', 'All', '', 'All', '', '']],
  ['communication.notices', ['All', 'All', 'VC', 'V', 'VCED', 'V', 'VC', 'V', 'V']],
  ['communication.emergency', ['All', 'All', '', '', '', '', 'All', 'All', '']],
  ['communication.surveys', ['All', 'All', 'V', 'V', 'All', '', 'V', '', '']],
  ['security.visitors', ['All', 'All', 'V', 'V', 'V', '', 'V', 'All', '']],
  ['security.guards', ['All', 'V', '', '', 'V', '', 'V', 'All', '']],
  ['security.incidents', ['All', 'All', 'V', 'V', 'V', '', 'V', 'All', '']],
  ['security.access_cards', ['All', 'All', '', '', 'All', '', 'All', 'All', '']],
  ['amenities.amenities', ['All', 'All', 'V', 'V', 'All', '', 'All', '', '']],
  ['amenities.bookings', ['All', 'All', 'V', 'V', 'VCEX', 'V', 'All', '', '']],
  ['parking.slots', ['All', 'All', 'V', 'V', 'All', '', 'All', 'V', '']],
  ['parking.vehicles', ['All', 'All', 'V', 'V', 'All', '', 'V', 'All', '']],
  ['parking.violations', ['All', 'All', 'V', 'V', 'VCE', '', 'VCE', 'VCE', '']],
  ['staff.society_staff', ['All', 'All', 'V', 'V', 'All', 'V', 'All', 'V', '']],
  ['staff.domestic_help', ['All', 'All', '', 'V', 'VCED', '', 'V', 'All', '']],
  ['staff.attendance', ['All', 'V', 'VX', 'V', 'All', 'VX', 'All', 'All', 'V']],
  ['vendors.vendors', ['All', 'All', 'VCE', 'V', 'VCE', 'V', 'All', '', 'V']],
  ['vendors.purchase_orders', ['All', 'VA', 'All', 'V', 'VCE', 'VC', 'VCE', '', 'V']],
  ['vendors.assets', ['All', 'V', 'V', 'V', 'VCE', '', 'All', '', 'V']],
  ['governance.meetings', ['All', 'All', 'V', 'VC', 'VCE', '', '', '', 'V']],
  ['governance.polls', ['All', 'All', 'V', 'VC', 'VCE', '', '', '', 'V']],
  ['governance.elections', ['All', 'All', 'V', 'V', 'V', '', '', '', 'V']],
  ['documents.documents', ['All', 'All', 'VC', 'V', 'All', 'VC', 'VC', 'V', 'V']],
  ['documents.registers', ['All', 'All', 'V', 'V', 'VE', '', '', '', 'VX']],
  ['documents.compliance', ['All', 'All', 'V', 'V', 'All', '', 'VE', '', 'V']],
  ['documents.rules', ['All', 'All', 'V', 'V', 'VCE', '', 'VC', 'VC', 'V']],
  ['documents.certificates', ['All', 'All', 'VA', 'V', 'VC', '', '', '', 'V']],
  ['community.posts', ['All', 'All', 'V', 'V', 'All', '', '', '', '']],
  ['community.events', ['All', 'All', 'V', 'VCE', 'All', '', 'V', '', '']],
  ['reports.reports', ['All', 'All', 'All', 'V', 'V', 'All', 'V', 'V', 'All']],
  ['settings.society', ['All', 'VE', 'V', 'V', 'All', '', 'V', '', 'V']],
  ['settings.members', ['All', 'VCE', 'V', 'V', 'All', '', 'V', 'V', 'V']],
  ['settings.roles', ['All', 'V', 'V', '', 'VCE', '', '', '', '']],
  ['settings.billing_rules', ['All', 'V', 'All', 'V', 'V', 'V', '', '', 'V']],
  ['settings.approval_rules', ['All', 'V', 'V', 'V', 'V', '', '', '', 'V']],
  ['settings.integrations', ['All', 'VA', 'VA', '', 'VE', '', '', '', '']],
  ['settings.subscription', ['All', 'V', 'VE', '', 'All', '', '', '', '']],
  ['settings.audit_log', ['All', 'V', 'V', '', 'V', '', '', '', 'All']],
  ['settings.support_access', ['All', 'V', '', '', 'All', '', '', '', '']],
  ['settings.data_export', ['All', 'All', 'V', '', 'All', '', '', '', '']],
  ['settings.support', ['All', 'All', 'All', 'V', 'All', 'All', 'All', '', '']],
  ['ai.assistant', ['All', 'VC', 'VC', 'VC', 'VC', 'VC', 'VC', '', 'V']],
  ['ai.copilot', ['All', 'C', 'C', '', 'C', '', 'C', '', '']],
  ['ai.settings', ['All', 'V', 'V', '', 'All', '', '', '', '']],
  ['ai.usage', ['All', 'V', 'All', '', 'All', 'V', '', '', 'V']],
  ['ai.conversations', ['All', 'V', '', '', 'All', '', '', '', 'V']],
  ['automation.rules', ['All', 'All', 'VA', 'V', 'VCED', 'V', 'VCE', '', 'V']],
];
const OTHER_MATRIX: [string, Cell[]][] = [
  ['resident.home', ['All', 'All', 'All', '', '', '']],
  ['resident.dues', ['All', 'All', '', '', '', '']],
  ['resident.payments', ['All', 'All', '', '', '', '']],
  ['resident.household', ['All', 'All', 'V', '', '', '']],
  ['resident.visitors', ['All', 'All', 'All', '', '', '']],
  ['resident.helpdesk', ['All', 'All', 'All', '', '', '']],
  ['resident.notices', ['All', 'All', 'All', '', '', '']],
  ['resident.amenities', ['All', 'All', 'VC', '', '', '']],
  ['resident.polls', ['All', 'V', 'V', '', '', '']],
  ['resident.community', ['All', 'All', 'All', '', '', '']],
  ['resident.documents', ['All', 'VC', 'V', '', '', '']],
  ['resident.requests', ['All', 'VC', '', '', '', '']],
  ['resident.finances', ['All', 'All', 'All', '', '', '']],
  ['resident.assistant', ['All', 'All', 'All', '', '', '']],
  ['work.tasks', ['', '', '', '', 'All', 'All']],
  ['work.attendance', ['', '', '', '', 'All', '']],
  ['work.checklists', ['', '', '', '', 'All', 'V']],
  ['work.building_issues', ['', '', '', '', 'All', '']],
];

function cellKeys(subMaster: string, cell: Cell): string[] {
  if (!cell) return [];
  const row = Object.values(CATALOGUE)
    .flat()
    .find(r => r[0] === subMaster);
  if (!row) throw new Error(`Unknown sub-master ${subMaster}`);
  if (cell === 'All') return row[1].map(a => `${subMaster}.${a}`);
  return [...cell].map(ch => {
    const action = LETTER[ch];
    if (!action || !row[1].includes(action)) throw new Error(`Bad matrix cell ${subMaster} ${cell}`);
    return `${subMaster}.${action}`;
  });
}

function buildDefaults(): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  const add = (role: string, keys: string[]) => {
    out[role] ??= new Set();
    for (const k of keys) out[role]!.add(k);
  };
  SOCIETY_MATRIX.forEach(([sub, cells]) =>
    cells.forEach((c, i) => add(SOCIETY_ROLE_ORDER[i]!, cellKeys(sub, c))),
  );
  OTHER_MATRIX.forEach(([sub, cells]) =>
    cells.forEach((c, i) => add(RESIDENT_ROLE_ORDER[i]!, cellKeys(sub, c))),
  );
  add('guard', keysOfScope('gate'));
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

/** Section 7.9 as sorted key lists per system role key. `POST /roles/:id/reset` restores these. */
export const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = buildDefaults();

// ------------------------------------------------------------------ household (BR-03-16)
export const HOUSEHOLD_ALLOW_KEYS = [
  'resident.dues.view',
  'resident.payments.view',
  'resident.payments.create',
  'resident.requests.view',
  'resident.requests.create',
  'resident.household.create',
  'resident.household.edit',
] as const;
export const HOUSEHOLD_DENY_KEYS = [
  'resident.amenities.create',
  'resident.visitors.create',
  'resident.visitors.approve',
] as const;

/** Labels of the household toggles (section 8.18 and 11.8). */
export const HOUSEHOLD_LABELS: Record<string, string> = {
  'resident.dues.view': 'See dues and statement',
  'resident.payments.view': 'See payments and receipts',
  'resident.payments.create': 'Pay dues',
  'resident.requests.view': 'See requests',
  'resident.requests.create': 'Raise requests',
  'resident.household.create': 'Add household members',
  'resident.household.edit': 'Edit household members',
  'resident.amenities.create': 'Book amenities',
  'resident.visitors.create': 'Pre-approve guests',
  'resident.visitors.approve': 'Approve visitors at the gate',
};

/** Audit and cache vocabulary. */
export const AUDIT = {
  roleCreated: 'access.role.created',
  roleUpdated: 'access.role.updated',
  rolePermissionsChanged: 'access.role.permissions_changed',
  roleReset: 'access.role.reset',
  roleDeleted: 'access.role.deleted',
  memberJoined: 'access.member.joined',
  memberUpdated: 'access.member.updated',
  memberRoleChanged: 'access.member.role_changed',
  memberSuspended: 'access.member.suspended',
  memberReactivated: 'access.member.reactivated',
  memberEnded: 'access.member.ended',
  memberExported: 'access.member.exported',
  memberMfaReset: 'access.member.mfa_reset',
  memberSessionsRevoked: 'access.member.sessions_revoked',
  invitationCreated: 'access.invitation.created',
  invitationResent: 'access.invitation.resent',
  invitationRevoked: 'access.invitation.revoked',
  invitationAccepted: 'access.invitation.accepted',
  invitationDeclined: 'access.invitation.declined',
  invitationExpired: 'access.invitation.expired',
  grantCreated: 'access.grant.created',
  grantRevoked: 'access.grant.revoked',
  grantExpired: 'access.grant.expired',
  grantHouseholdUpdated: 'access.grant.household_updated',
  platformInvitationCreated: 'access.platform_invitation.created',
  platformInvitationResent: 'access.platform_invitation.resent',
  platformInvitationRevoked: 'access.platform_invitation.revoked',
  platformMemberRoleChanged: 'access.platform_member.role_changed',
  platformMemberDisabled: 'access.platform_member.disabled',
  platformMemberEnabled: 'access.platform_member.enabled',
  platformMemberRemoved: 'access.platform_member.removed',
  platformMemberMfaReset: 'access.platform_member.mfa_reset',
  catalogueSynced: 'access.catalogue.synced',
} as const;
