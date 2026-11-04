/**
 * Names, enums, constants and keys of module 11 (sections 2, 5, 7 and 9). The enums are shared with the migrations'
 * CHECKs and with Zod (`z.enum(X)`); keep the three lists identical.
 */
export const BILLING_QUEUE = 'billing';
/** Section 9.1 jobs of queue `billing`. */
export const JOBS = {
  computeRun: 'billing:compute-run',
  issueRun: 'billing:issue-run',
  startScheduledIssues: 'billing:start-scheduled-issues',
  renderPdf: 'billing:render-pdf',
  lateFees: 'billing:late-fees',
  dueReminders: 'billing:due-reminders',
  sendReminders: 'billing:send-reminders',
  reconcile: 'billing:reconcile',
} as const;

// ------------------------------------------------------------------ money and rules (section 5)
/** BR-11-30: 18 % GST = CGST 9 % + SGST 9 %; `percentOf(taxable, '9.0000')` per half. */
export const GST_RATE_PCT = '18.0000';
export const GST_HALF_RATE_PCT = '9.0000';
/** BR-11-30: default ₹7,500 per flat per month (module 08 `billing.gstExemptLimitPerUnitPaise`). */
export const DEFAULT_GST_EXEMPT_LIMIT_PAISE = 750_000;
/** BR-11-29: a bill that moves more than 25 % against the previous one gets warning `LARGE_VARIANCE`. */
export const VARIANCE_WARN_PCT = 25;
/** BR-11-18: non-occupancy cap, percent of the base heads. */
export const NOC_MAX_PERCENT = '10.0000';
/** BR-11-51: bye-law cap on simple interest per annum. */
export const MAX_INTEREST_PCT = '21.0000';
/** BR-11-63 automatic reminders: `billing.invoice_due_soon` 3 days before the due date. */
export const REMINDER_DUE_SOON_DAYS = 3;
/** BR-11-63: `billing.invoice_overdue` on dueDate + 1, then every 7 days. */
export const REMINDER_OVERDUE_FIRST_OFFSET_DAYS = 1;
export const REMINDER_OVERDUE_INTERVAL_DAYS = 7;
/** BR-11-63: at most 4 overdue reminders per invoice. */
export const REMINDER_OVERDUE_MAX = 4;
/** BR-11-63: manual and bulk reminders, at most one per invoice per 24 hours. */
export const REMINDER_MIN_GAP_HOURS = 24;
/** BR-11-64 defaulter defaults. */
export const DEFAULTER_MIN_DAYS_OVERDUE = 90;
export const DEFAULTER_MIN_AMOUNT_PAISE = 500_000;
/** BR-11-33 / BR-11-37 batch sizes. */
export const COMPUTE_BATCH_UNITS = 200;
export const ISSUE_BATCH_ITEMS = 100;

// ------------------------------------------------------------------ enums (section 7)
export const HEAD_TYPES = [
  'MAINTENANCE',
  'SINKING_FUND',
  'REPAIR_FUND',
  'PARKING',
  'WATER',
  'ELECTRICITY',
  'NON_OCCUPANCY',
  'FESTIVAL',
  'COLLECTION',
  'BOUNCE_CHARGE',
  'MEMBERSHIP',
  'DEPOSIT',
  'AMENITY',
  'FINE',
  'SERVICE',
  'TRANSFER',
  'INTEREST',
  'LATE_FEE',
  'OPENING_ARREARS',
  'OTHER',
] as const;
export type HeadType = (typeof HEAD_TYPES)[number];
export const PAYER_ROUTINGS = ['OWNER', 'BILL_TO'] as const;
export type PayerRouting = (typeof PAYER_ROUTINGS)[number];
export const GST_TREATMENTS = ['NONE', 'THRESHOLD', 'ALWAYS', 'FOLLOW_SOURCE'] as const;
export type GstTreatment = (typeof GST_TREATMENTS)[number];
export const CONFIG_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type ConfigStatus = (typeof CONFIG_STATUSES)[number];
/** BR-11-9: heads of these types must be routed to the owner. */
export const OWNER_ONLY_HEAD_TYPES: readonly HeadType[] = ['SINKING_FUND', 'REPAIR_FUND', 'NON_OCCUPANCY'];
/** BR-11-31: heads of these types may never be `THRESHOLD`. */
export const NEVER_THRESHOLD_HEAD_TYPES: readonly HeadType[] = [
  'TRANSFER',
  'MEMBERSHIP',
  'COLLECTION',
  'BOUNCE_CHARGE',
  'DEPOSIT',
];
export const SYSTEM_HEAD_KEYS = ['INTEREST', 'LATE_FEE', 'OPENING_ARREARS'] as const;
export const CHARGE_HEAD_KEY_RE = /^[A-Z][A-Z0-9_]{1,39}$/;

export const SCOPE_TYPES = ['ALL_UNITS', 'BUILDINGS', 'UNIT_TYPES', 'UNITS'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];
export const RUN_SCOPE_TYPES = ['ALL_UNITS', 'BUILDINGS', 'UNITS'] as const;
export type RunScopeType = (typeof RUN_SCOPE_TYPES)[number];

export const RATE_TYPES = [
  'FLAT_PER_UNIT',
  'PER_SQFT',
  'PER_UNIT_TYPE',
  'METERED',
  'SPLIT_TOTAL',
  'PERCENT_OF_HEADS',
  'NONE',
] as const;
export type RateType = (typeof RATE_TYPES)[number];
export const METER_TYPES = ['WATER', 'ELECTRICITY', 'GAS'] as const;
export type MeterType = (typeof METER_TYPES)[number];
export const MISSING_READING_POLICIES = ['EXCEPTION', 'MINIMUM_CHARGE'] as const;
export type MissingReadingPolicy = (typeof MISSING_READING_POLICIES)[number];
export const RULE_VERSION_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'] as const;
export type RuleVersionStatus = (typeof RULE_VERSION_STATUSES)[number];

export const SPLIT_BASES = ['EQUAL', 'AREA', 'UNIT_TYPE_WEIGHT', 'CUSTOM_WEIGHT'] as const;
export type SplitBasis = (typeof SPLIT_BASES)[number];
export const SPLIT_AMOUNT_SOURCES = ['FIXED', 'RUN_INPUT'] as const;
export type SplitAmountSource = (typeof SPLIT_AMOUNT_SOURCES)[number];

export const CYCLES = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL'] as const;
export type BillingCycle = (typeof CYCLES)[number];
/** BR-11-16: months per period. */
export const CYCLE_MONTHS: Record<BillingCycle, 1 | 3 | 6 | 12> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  HALF_YEARLY: 6,
  ANNUAL: 12,
};

export const RUN_TYPES = ['REGULAR', 'SUPPLEMENTARY'] as const;
export type RunType = (typeof RUN_TYPES)[number];
export const RUN_STATUSES = [
  'DRAFT',
  'COMPUTING',
  'PREVIEW',
  'PENDING_APPROVAL',
  'APPROVED',
  'ISSUING',
  'ISSUED',
  'CANCELLED',
  'FAILED',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const BILL_TO_RELATIONS = ['OWNER', 'CO_OWNER', 'TENANT'] as const;
export type BillToRelation = (typeof BILL_TO_RELATIONS)[number];
export const ITEM_STATUSES = ['READY', 'EXCEPTION', 'EXCLUDED', 'ISSUED'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const EXCEPTION_CODES = [
  'MISSING_AREA',
  'MISSING_UNIT_TYPE_RATE',
  'MISSING_READING',
  'NO_BILL_TO',
  'ALREADY_BILLED',
] as const;
export type ExceptionCode = (typeof EXCEPTION_CODES)[number];
export const WARNING_CODES = [
  'LARGE_VARIANCE',
  'ESTIMATED_READING',
  'MINIMUM_CHARGE_APPLIED',
  'PRORATED',
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export const INVOICE_TYPES = ['REGULAR', 'SUPPLEMENTARY', 'ADHOC', 'OPENING'] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];
export const INVOICE_STATUSES = ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const PDF_STATUSES = ['PENDING', 'READY', 'FAILED'] as const;
export type PdfStatus = (typeof PDF_STATUSES)[number];

export const LINE_KINDS = [
  'CHARGE',
  'INTEREST',
  'LATE_FEE',
  'CGST',
  'SGST',
  'ROUND_OFF',
  'WRITE_OFF',
] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export const NOTE_TYPES = ['CREDIT', 'DEBIT'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];
export const NOTE_REASON_CODES = [
  'BILLING_ERROR',
  'WAIVER',
  'DISPUTE_RESOLUTION',
  'CANCELLATION',
  'WRITE_OFF',
  'SOURCE_REFUND',
  'INTEREST',
  'LATE_FEE',
  'ADDITIONAL_CHARGE',
  'OTHER',
] as const;
export type NoteReasonCode = (typeof NOTE_REASON_CODES)[number];
export const CREDIT_REASON_CODES: readonly NoteReasonCode[] = [
  'BILLING_ERROR',
  'WAIVER',
  'DISPUTE_RESOLUTION',
  'CANCELLATION',
  'WRITE_OFF',
  'SOURCE_REFUND',
  'OTHER',
];
export const DEBIT_REASON_CODES: readonly NoteReasonCode[] = [
  'INTEREST',
  'LATE_FEE',
  'ADDITIONAL_CHARGE',
  'BILLING_ERROR',
  'OTHER',
];
export const NOTE_STATUSES = ['PENDING_APPROVAL', 'CHANGES_REQUESTED', 'ISSUED', 'REJECTED'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];
export const NOTE_APPROVAL_TYPES = ['CREDIT_NOTE', 'INVOICE_CANCEL', 'WRITE_OFF'] as const;
export type NoteApprovalType = (typeof NOTE_APPROVAL_TYPES)[number];

export const LATE_FEE_POLICY_TYPES = ['NONE', 'SIMPLE_INTEREST', 'FLAT'] as const;
export type LateFeePolicyType = (typeof LATE_FEE_POLICY_TYPES)[number];
export const INTEREST_FROM = ['DUE_DATE', 'GRACE_END'] as const;
export type InterestFrom = (typeof INTEREST_FROM)[number];
export const LATE_FEE_STATUSES = ['PENDING_APPROVAL', 'ACTIVE', 'REJECTED'] as const;
export type LateFeeStatus = (typeof LATE_FEE_STATUSES)[number];

export const LEDGER_ENTRY_TYPES = [
  'OPENING_BALANCE',
  'INVOICE',
  'DEBIT_NOTE',
  'CREDIT_NOTE',
  'PAYMENT',
  'PAYMENT_REVERSAL',
  'REFUND',
  'ADJUSTMENT',
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];
export const LEDGER_REF_TYPES = ['invoice', 'billing_note', 'opening_balance', 'payment', 'refund'] as const;
export type LedgerRefType = (typeof LEDGER_REF_TYPES)[number];

export const OPENING_STATUSES = ['DRAFT', 'INVALID', 'POSTED', 'REVERSED'] as const;
export type OpeningStatus = (typeof OPENING_STATUSES)[number];

// ------------------------------------------------------------------ approvals, files, permissions, features
/** Section 2: approval types (module 14 catalogue); the last two are NEW in module 14 §5.1. */
export const APPROVAL_TYPES = {
  runPublish: 'BILLING_RUN_PUBLISH',
  creditNote: 'CREDIT_NOTE',
  writeOff: 'WRITE_OFF',
  invoiceCancel: 'INVOICE_CANCEL',
  ruleChange: 'BILLING_RULE_CHANGE',
  lateFeePolicyChange: 'LATE_FEE_POLICY_CHANGE',
} as const;
/** BR-11-67: file purpose of the bill PDF (financial file, kept by the module 05 purge). */
export const INVOICE_PDF_PURPOSE = 'INVOICE_PDF';

export const PERMISSIONS = {
  rulesView: 'settings.billing_rules.view',
  rulesEdit: 'settings.billing_rules.edit',
  view: 'finance.billing.view',
  create: 'finance.billing.create',
  edit: 'finance.billing.edit',
  import: 'finance.billing.import',
  export: 'finance.billing.export',
  approve: 'finance.billing.approve',
  residentDuesView: 'resident.dues.view',
} as const;

/** Section 2 entitlement keys of this edition (module 04 catalogue). */
export const FEATURES = {
  chargeHeadMaster: 'billing.charge_head_master',
  calculationMethods: 'billing.calculation_methods',
  versionedRules: 'billing.versioned_billing_rules',
  unitOverrides: 'billing.unit_overrides_and_exemptions',
  billingCycles: 'billing.billing_cycles',
  runPipeline: 'billing.billing_run_pipeline',
  exceptionsReport: 'billing.exceptions_report',
  fyNumbering: 'billing.fy_invoice_numbering',
  gstHandling: 'billing.gst_handling',
  lateFeeAndInterest: 'billing.late_fee_and_interest',
  openingBalances: 'billing.opening_balances',
  arrearsCarryForward: 'billing.arrears_carry_forward',
  creditNotes: 'billing.credit_notes',
  debitNotes: 'billing.debit_notes',
  adHocInvoices: 'billing.supplementary_and_ad_hoc_invoices',
  statement: 'billing.statement_of_account',
  invoicePdf: 'billing.invoice_pdf_with_upi_qr',
  ownerTenantSplit: 'billing.owner_and_tenant_bill_split',
  prorated: 'billing.prorated_billing',
  rounding: 'billing.rounding_rules',
  defaulterList: 'billing.defaulter_list',
  explainMyBill: 'billing.explain_my_bill',
  billChangeDiff: 'billing.bill_change_diff',
  meteredWater: 'billing.metered_water_slabs',
} as const;

// ------------------------------------------------------------------ audit (section 9.3) and realtime (9.4)
export const AUDIT = {
  chargeHeadCreated: 'billing.charge_head.created',
  chargeHeadUpdated: 'billing.charge_head.updated',
  chargeHeadArchived: 'billing.charge_head.archived',
  ruleCreated: 'billing.rule.created',
  ruleUpdated: 'billing.rule.updated',
  ruleArchived: 'billing.rule.archived',
  ruleVersionCreated: 'billing.rule_version.created',
  ruleVersionApproved: 'billing.rule_version.approved',
  ruleVersionRejected: 'billing.rule_version.rejected',
  splitRuleCreated: 'billing.split_rule.created',
  splitRuleUpdated: 'billing.split_rule.updated',
  splitRuleArchived: 'billing.split_rule.archived',
  lateFeePolicyCreated: 'billing.late_fee_policy.created',
  lateFeePolicyApproved: 'billing.late_fee_policy.approved',
  lateFeePolicyRejected: 'billing.late_fee_policy.rejected',
  runCreated: 'billing.run.created',
  runUpdated: 'billing.run.updated',
  runRecomputed: 'billing.run.recomputed',
  runComputed: 'billing.run.computed',
  runFailed: 'billing.run.failed',
  runPublishRequested: 'billing.run.publish_requested',
  runApproved: 'billing.run.approved',
  runRejected: 'billing.run.rejected',
  runChangesRequested: 'billing.run.changes_requested',
  runIssued: 'billing.run.issued',
  runCancelled: 'billing.run.cancelled',
  runIssueResumed: 'billing.run.issue_resumed',
  runItemExcluded: 'billing.run_item.excluded',
  runItemIncluded: 'billing.run_item.included',
  invoiceIssued: 'billing.invoice.issued',
  invoiceCreatedAdhoc: 'billing.invoice.created_adhoc',
  invoiceCancelRequested: 'billing.invoice.cancel_requested',
  invoiceCancelled: 'billing.invoice.cancelled',
  invoiceReminded: 'billing.invoice.reminded',
  invoiceDisputeFlagChanged: 'billing.invoice.dispute_flag_changed',
  remindersBulkSent: 'billing.reminders.bulk_sent',
  creditNoteRequested: 'billing.credit_note.requested',
  creditNoteIssued: 'billing.credit_note.issued',
  creditNoteRejected: 'billing.credit_note.rejected',
  creditNoteResubmitted: 'billing.credit_note.resubmitted',
  creditNoteWithdrawn: 'billing.credit_note.withdrawn',
  creditNoteIssuedBySource: 'billing.credit_note.issued_by_source',
  invoiceCancelledBySource: 'billing.invoice.cancelled_by_source',
  debitNoteIssued: 'billing.debit_note.issued',
  writeOffRequested: 'billing.write_off.requested',
  writeOffIssued: 'billing.write_off.issued',
  writeOffRejected: 'billing.write_off.rejected',
  openingImported: 'billing.opening_balance.imported',
  openingPosted: 'billing.opening_balance.posted',
  openingReversed: 'billing.opening_balance.reversed',
  openingDeleted: 'billing.opening_balance.deleted',
  invoicesExported: 'billing.invoices.exported',
  defaultersExported: 'billing.defaulters.exported',
} as const;
/** Audit reason when a rule version or policy is approved immediately during setup mode (BR-11-21). */
export const SETUP_MODE_REASON = 'SETUP_MODE';

export const REALTIME = {
  runUpdated: 'billing.run.updated',
  invoiceUpdated: 'billing.invoice.updated',
  duesChanged: 'billing.dues.changed',
  exportReady: 'billing.export.ready',
} as const;
