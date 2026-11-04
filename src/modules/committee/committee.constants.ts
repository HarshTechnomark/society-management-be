/** Names, enums and keys of module 10 (sections 2.2, 5, 7 and 9). The enums are shared with Zod. */
export const COMMITTEE_QUEUE = 'members';
/** Section 9.1 jobs of queue `members`. */
export const JOBS = {
  termReminders: 'members:term-reminders',
  termAutoExpiry: 'members:term-auto-expiry',
  reconcileSeats: 'members:reconcile-seats',
} as const;
/** BR-10-24: hand-over reminders on these days after `tookChargeOn` while the checklist is incomplete (section 9.1). */
export const HANDOVER_REMINDER_DAYS = [15, 30] as const;

export const DESIGNATIONS = [
  'CHAIRMAN',
  'VICE_CHAIRMAN',
  'SECRETARY',
  'JOINT_SECRETARY',
  'TREASURER',
  'MEMBER',
] as const;
export type Designation = (typeof DESIGNATIONS)[number];

/** BR-10-6. */
export const DESIGNATION_ROLE = {
  CHAIRMAN: 'chairman',
  VICE_CHAIRMAN: 'committee_member',
  SECRETARY: 'secretary',
  JOINT_SECRETARY: 'committee_member',
  TREASURER: 'treasurer',
  MEMBER: 'committee_member',
} as const satisfies Record<Designation, string>;
export const COMMITTEE_ROLE_KEYS = ['chairman', 'secretary', 'treasurer', 'committee_member'] as const;

/** BR-10-4: unique among PLANNED and SEATED seats of a term. */
export const UNIQUE_DESIGNATIONS = [
  'CHAIRMAN',
  'VICE_CHAIRMAN',
  'SECRETARY',
  'JOINT_SECRETARY',
  'TREASURER',
] as const satisfies readonly Designation[];
/** Shown first on the resident page, in this order (BR-10-28). */
export const DESIGNATION_ORDER: readonly Designation[] = DESIGNATIONS;
export const DESIGNATION_LABEL: Record<Designation, string> = {
  CHAIRMAN: 'Chairman',
  VICE_CHAIRMAN: 'Vice Chairman',
  SECRETARY: 'Secretary',
  JOINT_SECRETARY: 'Joint Secretary',
  TREASURER: 'Treasurer',
  MEMBER: 'Member',
};
/** BR-10-5: needed to activate a term. */
export const REQUIRED_OFFICE_BEARERS = ['CHAIRMAN', 'SECRETARY', 'TREASURER'] as const;

export const PORTFOLIOS = [
  'ACCOUNTS',
  'MAINTENANCE',
  'SECURITY',
  'EVENTS',
  'LEGAL',
  'HOUSEKEEPING',
  'PARKING',
  'OTHER',
] as const;
export const JOIN_MODES = ['ELECTED', 'CO_OPTED', 'NOMINATED', 'APPOINTED'] as const;
export const SEAT_STATUSES = ['PLANNED', 'SEATED', 'LEFT'] as const;
export const EXIT_REASONS = [
  'TERM_ENDED',
  'RESIGNED',
  'REMOVED',
  'DECEASED',
  'DISQUALIFIED',
  'REDESIGNATED',
  'MEMBERSHIP_ENDED',
] as const;
export const SEAT_FLAGS = ['ROLE_MISMATCH', 'MEMBERSHIP_SUSPENDED', 'NOT_OWNER'] as const;
export const TERM_KINDS = ['ELECTED', 'PROVISIONAL', 'AD_HOC'] as const;
export const TERM_SOURCES = ['MANUAL', 'ELECTION', 'HISTORICAL'] as const;
export const TERM_STATUSES = ['DRAFT', 'ACTIVE', 'EXPIRED', 'ENDED'] as const;
export const HANDOVER_STATUSES = ['PENDING', 'DONE', 'NOT_APPLICABLE'] as const;
export type TermStatus = (typeof TERM_STATUSES)[number];
export type TermSource = (typeof TERM_SOURCES)[number];

/** BR-10-32 and section 7.1: bounded JSON collections. */
export const MAX_SEATS_STORED = 150;
export const MAX_SEATS_INPUT = 25;
export const MAX_HANDOVER_ITEMS = 40;
/** BR-10-2: shortest term in days. */
export const MIN_TERM_DAYS = 30;
/** Banner threshold of 8.1 (days). */
export const TERM_ENDING_BANNER_DAYS = 90;

/** Entitlement keys of section 2.2 (module 04 catalogue). */
export const FEATURE = {
  terms: 'governance.committee_terms',
  officeBearers: 'governance.office_bearers',
  autoExpiry: 'iam.committee_term_auto_expiry',
} as const;

export const ENTITY = { term: 'committee_term' } as const;

/** Section 9.3 (the actions of parts 10.2 and 10.3 are listed here so that every part uses the same strings). */
export const AUDIT = {
  created: 'committee.term.created',
  createdFromElection: 'committee.term.created_from_election',
  updated: 'committee.term.updated',
  extended: 'committee.term.extended',
  deleted: 'committee.term.deleted',
  activated: 'committee.term.activated',
  ended: 'committee.term.ended',
  expired: 'committee.term.expired',
  changed: 'committee.term.changed',
  seatAdded: 'committee.seat.added',
  seatRedesignated: 'committee.seat.redesignated',
  seatVacated: 'committee.seat.vacated',
  seatUpdated: 'committee.seat.updated',
  seatFlagged: 'committee.seat.flagged',
  handoverItemAdded: 'committee.handover.item_added',
  handoverItemUpdated: 'committee.handover.item_updated',
  handoverCompleted: 'committee.handover.completed',
} as const;

/** Section 9.4 `committee.changed` reasons. */
export type ChangeReason = 'CREATED' | 'UPDATED' | 'ACTIVATED' | 'CHANGED' | 'EXPIRED' | 'HANDOVER';

/** Section 7.3: the default checklist (the `committee.handoverTemplate` setting default, used by the demo seed). */
export const DEFAULT_HANDOVER_TEMPLATE: { title: string; ownerDesignation: Designation | null }[] = [
  { title: 'Bank signatories and mandate changed', ownerDesignation: 'TREASURER' },
  { title: 'Cheque books, cash and petty cash handed over', ownerDesignation: 'TREASURER' },
  { title: 'Payment gateway, UPI and banking app access updated', ownerDesignation: 'TREASURER' },
  { title: 'Society seal and rubber stamps handed over', ownerDesignation: 'SECRETARY' },
  {
    title: 'Statutory registers, share certificates and minute books handed over',
    ownerDesignation: 'SECRETARY',
  },
  { title: 'Files, agreements, AMCs and vendor contracts handed over', ownerDesignation: 'SECRETARY' },
  { title: 'Keys (office, terrace, lift and pump rooms) handed over', ownerDesignation: 'SECRETARY' },
  { title: 'Registrar informed of the new committee', ownerDesignation: 'SECRETARY' },
  { title: 'Society email, website and social media passwords changed', ownerDesignation: 'CHAIRMAN' },
  { title: 'Pending court cases, notices and dues of the society briefed', ownerDesignation: 'CHAIRMAN' },
];
