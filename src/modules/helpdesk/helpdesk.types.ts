import type { Transaction } from 'sequelize';
import type { Ctx, SystemCtx } from '../../types/context';
import type {
  AffectedLevel,
  AssigneeType,
  CallerType,
  Channel,
  Priority,
  ReporterRole,
  SlaCalendar,
  TicketKind,
  TicketStatus,
  TransitionAction,
  Urgency,
  Visibility,
  WaitingReason,
} from './helpdesk.constants';

export type { Ctx, SystemCtx, Transaction };

/** `YYYY-MM-DD` (society local date). */
export type YmdString = string;

/** The office calendar business-hours SLA runs on (BR-15-25): module 08 `office.*` settings and `holidays.isWorkingDay`. */
export interface BusinessCalendar {
  isWorkingDay(ymd: YmdString): Promise<boolean> | boolean;
  /** `HH:MM` in the society time zone. */
  openTime: string;
  closeTime: string;
}

/** The four SLA numbers a ticket snapshots from a policy (BR-15-23, BR-15-24). */
export interface SlaSnapshot {
  slaPolicyId: number;
  slaCalendar: SlaCalendar;
  responseMinutes: number;
  resolutionMinutes: number;
}

/** What `slaDue` computes (BR-15-26). */
export interface SlaDue {
  responseDueAt: Date;
  resolutionDueAt: Date;
}

/** Fields of a ticket the pure state machine and SLA functions read. */
export interface TicketFacts {
  status: TicketStatus;
  kind: TicketKind;
  requesterUserId: number | null;
  waitingReason: WaitingReason | null;
  chargeStatus: string;
  resolvedAt: Date | null;
  reopenCount: number;
}

/** The caller as the state machine sees it (6.2). A person can be several types at once. */
export type CallerTypes = ReadonlySet<CallerType>;

export interface TransitionInput {
  action: TransitionAction;
  note?: string;
  reason?: string;
  waitingReason?: WaitingReason;
  fileIds?: number[];
  chargeFinalPaise?: number;
  waiveReason?: string;
  version?: number;
}

/** Who acts on a ticket: the context plus the types the caller holds for this ticket. */
export interface Actor {
  ctx: Ctx | SystemCtx;
  types: CallerTypes;
  /** Display snapshot for timeline rows. */
  name: string;
  /** Author role of comments written by this actor. */
  role: 'RESIDENT' | 'ADMIN' | 'STAFF' | 'VENDOR' | 'GUARD' | 'SYSTEM';
  userId: number | null;
}

/** Input of the single create function (BR-15-1 to BR-15-18); routes of part 15.2 and 15.3 map their bodies onto it. */
export interface CreateTicketInput {
  kind: TicketKind;
  categoryId: number;
  subCategoryId?: number | null;
  unitId?: number | null;
  locationNodeId?: number | null;
  affectedLevel?: AffectedLevel | null;
  title?: string;
  description?: string;
  urgency?: Urgency;
  /** Admin routes only: overrides urgency (BR-15-8). */
  priority?: Priority;
  channel: Channel;
  reporterRole: ReporterRole;
  /** Requester when not the caller (on behalf, BR-15-12). */
  requesterUserId?: number | null;
  requesterName?: string;
  assetId?: number | null;
  invoiceId?: number | null;
  duplicateReason?: string;
  fileIds?: number[];
  preferredSlotFrom?: Date | null;
  preferredSlotTo?: Date | null;
}

export interface CreatedTicket {
  id: number;
  ticketNo: string;
  status: TicketStatus;
  priority: Priority;
  affectedUnitCount: number | null;
  assigned: boolean;
  similarOpenTicketIds: number[];
  isRecurring: boolean;
}

export interface SimilarTicket {
  id: number;
  ticketNo: string;
  title: string;
  status: TicketStatus;
  priority: Priority;
  locationNodeId: number | null;
  upvoteCount: number;
  createdAt: Date;
  sameNode: boolean;
}

export interface AssigneeInput {
  type: AssigneeType;
  userId?: number;
  staffId?: number;
  vendorId?: number;
  externalName?: string;
  externalMobile?: string;
  createWorkOrder?: boolean;
  note?: string;
}

export interface EffectiveCategory {
  categoryId: number;
  subCategoryId: number | null;
  categoryName: string;
  subCategoryName: string | null;
  scope: 'PERSONAL' | 'BUILDING' | 'BOTH';
  defaultPriority: Priority;
  slaPolicyId: number | null;
  defaultAssigneeType: 'NONE' | 'ROLE' | 'MEMBER' | 'STAFF' | 'VENDOR';
  defaultRoleKey: string | null;
  defaultAssigneeUserId: number | null;
  defaultStaffId: number | null;
  defaultVendorId: number | null;
  isChargeable: boolean;
  requiresAfterPhoto: boolean;
  isSafety: boolean;
  linksInvoice: boolean;
}

export type CommentVisibility = Visibility;
