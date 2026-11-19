import type { Transaction } from 'sequelize';
import type { Ctx, SystemCtx } from '../../types/context';
import type {
  AudienceRelation,
  AudienceType,
  Channel,
  DeliveryClass,
  EmergencyType,
  NoticeCategory,
  NoticeExtraChannel,
  TemplateCategory,
  TemplateScope,
  VariableType,
} from './communication.constants';

export type { Ctx, SystemCtx, Transaction };

/** Section 8.38 recipient union. A bare number is a user id. */
export type Recipient =
  | number
  | { userId: number; mobile?: string | null; email?: string | null }
  /** An external contact; the legacy shape may carry both a mobile and an e-mail (one recipient, e.g. `auth.account_deleted`). */
  | { mobile: string; email?: string | null }
  | { email: string }
  | { unitId: number; relation?: 'ANY' | 'OWNERS' | 'TENANTS' | 'BILL_TO' }
  | { roleKey: string }
  | { permission: string }
  | { audience: { type: 'ALL' | 'BUILDINGS' | 'UNITS'; relation?: AudienceRelation; ids?: number[] } }
  | { platformPermission: string };

/** Section 8.38 options. `channel` is the module 02 alias for `auth.otp`. */
export interface NotifyOptions {
  societyId?: number;
  channels?: Channel[];
  channel?: 'SMS' | 'WHATSAPP';
  dedupeKey?: string;
  locale?: string;
  sourceType?: string;
  sourceId?: number;
  pushSubscriptionId?: number;
  urgent?: boolean;
  /** No inbox item (push and SMS only, e.g. an emergency re-alert, BR-16-42). */
  skipInbox?: boolean;
}
export interface NotifyResult {
  batchId: string;
  accepted: number | null;
  queued: boolean;
  suppressed: boolean;
}

/** One variable of a template's `variablesSchema` (7.3). */
export interface VariableSpec {
  type: VariableType;
  required?: boolean;
  maxLength?: number;
  /** SMS cut for this value instead of the 30-character DLT default (emergency texts carry their message, BR-16-29 note). */
  smsMaxLength?: number;
}
export type VariablesSchema = Record<string, VariableSpec>;

/** Texts of one locale (7.3 columns). `{{name}}` placeholders must exist in the schema (BR-16-51). */
export interface ChannelTexts {
  inAppTitle?: string;
  inAppBody?: string;
  pushTitle?: string;
  pushBody?: string;
  smsBody?: string;
  smsDltTemplateId?: string;
  smsDltCategory?: 'SERVICE_IMPLICIT' | 'SERVICE_EXPLICIT' | 'TRANSACTIONAL';
  whatsappTemplateName?: string;
  whatsappCategory?: 'UTILITY' | 'AUTHENTICATION';
  whatsappParams?: string[];
  whatsappButtonVar?: string;
  whatsappStatus?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED';
  emailSubject?: string;
  emailHtml?: string;
  emailText?: string;
}

/** Section 10.2 `TemplateDefinition`: what each module registers in code (`templates:sync` upserts it). */
export interface TemplateDefinition {
  key: string;
  scope: TemplateScope;
  category: TemplateCategory;
  deliveryClass: DeliveryClass;
  defaultChannels: Channel[];
  allowedChannels: Channel[];
  variables: VariablesSchema;
  sample: Record<string, unknown>;
  countsTowardLimit?: boolean;
  allowEndedMembers?: boolean;
  sendWhenClosed?: boolean;
  deepLink?: string;
  text: { 'en-IN': ChannelTexts } & Partial<Record<string, ChannelTexts>>;
}

/** The rendered message of one channel (output of `communication.render.ts`). */
export interface Rendered {
  inApp?: { title: string; body: string };
  push?: { title: string; body: string };
  sms?: string;
  whatsapp?: { name: string; params: string[]; buttonSuffix?: string };
  email?: { subject: string; html: string; text: string };
  deepLink: string | null;
}

// ------------------------------------------------------------------ notices (8.38 `notices.*`)
export interface NoticeAudience {
  type: AudienceType;
  relation?: AudienceRelation;
  ids?: number[];
  roleKeys?: string[];
}
export interface NoticeActionInput {
  type: 'PAY_COLLECTION' | 'PAY_DUES' | 'RSVP' | 'VOTE' | 'LINK';
  refId?: number;
  url?: string;
  label?: string;
}
export interface SystemNoticeInput {
  sourceModule: string;
  sourceRefType: string;
  sourceRefId: number;
  title: string;
  body: string;
  category: NoticeCategory;
  audience: NoticeAudience;
  actions?: NoticeActionInput[];
  requiresAck?: boolean;
  expiresAt?: Date;
  channels?: NoticeExtraChannel[];
}
export interface StartFromSosInput {
  sosAlertId: number;
  type: EmergencyType;
  message: string;
  buildingIds?: number[];
}

/** A person in a resolved audience (BR-16-3, BR-16-4): one row per person per flat. */
export interface AudiencePerson {
  userId: number | null;
  residentId: number | null;
  unitId: number | null;
  relation: 'OWNER' | 'CO_OWNER' | 'TENANT' | 'FAMILY' | 'CARETAKER' | 'MEMBER';
  mobile: string | null;
}
export interface ResolvedAudience {
  people: AudiencePerson[];
  unitIds: number[];
  /** Distinct users with a login. */
  userIds: number[];
}
