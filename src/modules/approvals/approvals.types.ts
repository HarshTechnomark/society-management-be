import type { Transaction } from 'sequelize';
import type { Ctx } from '../../types/context';
import type { StepMode, RuleAction, SlotType } from './approvals.constants';

/** One step of a rule or of a rule snapshot (7.1.1). */
export interface RuleStep {
  stepNo: number;
  name: string;
  mode: StepMode;
  roleKeys: string[];
  userIds: number[];
  requiredCount: number | null;
}

/** The rule fields copied onto a request at routing time (BR-14-5). */
export interface RuleSnapshot {
  ruleId: number | null;
  ruleVersion: number | null;
  name: string;
  action: RuleAction;
  minAmountPaise: number;
  maxAmountPaise: number | null;
  categoryKeys: string[] | null;
  requesterRoleKeys: string[] | null;
  steps: RuleStep[];
  fallbackRoleKeys: string[];
  slaHours: number;
  reminderEveryHours: number;
  escalateAfterHours: number | null;
  escalationRoleKeys: string[];
  escalationCanApprove: boolean;
  stepUpAbovePaise: number | null;
}

/** What rule matching needs of a rule row (a plain shape, so matching is a pure function). */
export interface MatchableRule {
  id: number;
  priority: number;
  isActive: boolean;
  minAmountPaise: number;
  maxAmountPaise: number | null;
  categoryKeys: string[] | null;
  requesterRoleKeys: string[] | null;
}

export interface StepOverride {
  stepNo: number;
  round: number;
  slotIndex: number | null;
  userId: number;
  byUserId: number;
  at: string;
}

/** Section 8.20. */
export interface ApprovalDecisionInfo {
  requestId: number;
  decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED' | 'CANCELLED' | 'EXPIRED';
  actorUserId: number | null;
  onBehalfOfUserId: number | null;
  reason: string | null;
  /** The request payload (set by the entity-id port adapter `realApprovals`, for hooks that need what was asked). */
  payload?: Record<string, unknown>;
}
export type ApprovalCtx = Ctx & { approval: ApprovalDecisionInfo };

export interface ApprovalFact {
  label: string;
  value: string;
  kind: 'text' | 'money' | 'date' | 'unit' | 'file';
}
export interface ApprovalDescription {
  facts: ApprovalFact[];
  link: string | null;
}

/** The request row as handlers see it (a plain snapshot of the model). */
export interface ApprovalRequestView {
  id: number;
  societyId: number;
  type: string;
  entityType: string;
  entityId: number;
  title: string;
  summary: string | null;
  categoryKey: string | null;
  unitId: number | null;
  amountPaise: number;
  payload: Record<string, unknown>;
  status: string;
  routing: string;
  round: number;
  currentStepNo: number;
  totalSteps: number;
  requesterUserId: number;
  requesterKind: string;
  decisionReason: string | null;
  version: number;
}

export interface TypeHandlers {
  onApproved(ctx: ApprovalCtx, req: ApprovalRequestView, t: Transaction): Promise<void>;
  onRejected(ctx: ApprovalCtx, req: ApprovalRequestView, t: Transaction): Promise<void>;
  describe(req: ApprovalRequestView, viewer?: Ctx): ApprovalDescription | Promise<ApprovalDescription>;
  onChangesRequested?(ctx: ApprovalCtx, req: ApprovalRequestView, t: Transaction): Promise<void>;
  onCancelled?(ctx: ApprovalCtx, req: ApprovalRequestView, t: Transaction): Promise<void>;
  onExpired?(ctx: ApprovalCtx, req: ApprovalRequestView, t: Transaction): Promise<void>;
}

export interface RequestInput {
  type: string;
  entityType: string;
  entityId: number;
  title: string;
  amountPaise?: number;
  payload?: Record<string, unknown>;
  summary?: string;
  categoryKey?: string;
  unitId?: number;
  expiresAt?: Date;
}
export interface ResubmitInput {
  title?: string;
  summary?: string;
  amountPaise?: number;
  categoryKey?: string;
  payload?: Record<string, unknown>;
}

/** One member who may be an approver (role key and permission already resolved). */
export interface ApproverMember {
  userId: number;
  roleKey: string;
}

export interface SlotMatch {
  slotType: SlotType;
  slotRef: string;
}
