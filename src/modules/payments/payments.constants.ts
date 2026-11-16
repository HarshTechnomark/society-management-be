/**
 * Names, enums, limits and keys of module 12 (sections 2, 5, 7, 9, 10 and 12). The enums are shared with the migrations'
 * CHECKs and with Zod (`z.enum(X)`); keep the lists identical.
 */
export const PAYMENTS_QUEUE = 'payments';

/** Section 2.1 permission keys (no new keys). */
export const PERM = {
  paymentsView: 'finance.payments.view',
  paymentsCreate: 'finance.payments.create',
  paymentsEdit: 'finance.payments.edit',
  paymentsExport: 'finance.payments.export',
  paymentsApprove: 'finance.payments.approve',
  collectionsView: 'finance.collections.view',
  collectionsCreate: 'finance.collections.create',
  collectionsEdit: 'finance.collections.edit',
  collectionsDelete: 'finance.collections.delete',
  collectionsExport: 'finance.collections.export',
  collectionsApprove: 'finance.collections.approve',
  residentDuesView: 'resident.dues.view',
  residentPaymentsView: 'resident.payments.view',
  residentPaymentsCreate: 'resident.payments.create',
  residentFinancesView: 'resident.finances.view',
} as const;

/** Section 2.2 entitlement keys. */
export const ENT = {
  collections: 'billing.festival_and_event_collections',
  payablesList: 'billing.one_payables_list_per_flat',
  oneCheckout: 'payments.one_checkout_for_everything',
  liveBalance: 'payments.instant_payment_to_society_balance',
  orders: 'payments.payment_orders',
  merchantAccounts: 'payments.per_society_merchant_accounts',
  upiAndQr: 'payments.upi_intent_collect_and_dynamic_qr',
  cardsNetbanking: 'payments.cards_and_netbanking',
  webhooks: 'payments.webhooks_and_polling',
  allocationEngine: 'payments.allocation_engine',
  partialAdvance: 'payments.partial_and_advance_payments',
  unitWallet: 'payments.unit_wallet',
  cashBankEntry: 'payments.cash_and_bank_transfer_entry',
  chequeLifecycle: 'payments.cheque_lifecycle',
  declaredTransfers: 'payments.resident_declared_transfers',
  receipts: 'payments.receipts',
  convenienceFee: 'payments.convenience_fee_pass_through',
  refunds: 'payments.refunds_and_reversals',
  paymentLinks: 'payments.payment_links',
  whatsappLink: 'payments.whatsapp_payment_link',
  recovery: 'payments.failed_payment_recovery',
  familyPay: 'payments.family_pay',
  upiAutopay: 'payments.upi_autopay_mandates',
  enach: 'payments.e_nach_mandates',
  efficiency: 'payments.collection_efficiency_analytics',
} as const;
/** Module 04 feature flag of the mandate routes. */
export const FLAG_UPI_AUTOPAY = 'payments.upi_autopay';

/** Module 14 approval types of this module. */
export const APPROVAL_TYPES = {
  offlinePayment: 'OFFLINE_PAYMENT',
  paymentRefund: 'PAYMENT_REFUND',
  collectionPublish: 'COLLECTION_PUBLISH',
} as const;
/** Entity types used with `approvals.request` / `lockOpenForEntity`. */
export const ENTITY = { payment: 'payment', refund: 'refund', collection: 'collection' } as const;

/** Section 9.1 jobs of queue `payments`. */
export const JOBS = {
  processWebhook: 'payments:process-webhook',
  reconcileOrders: 'payments:reconcile-orders',
  renderReceipt: 'payments:render-receipt',
  applyAdvances: 'payments:apply-advances',
  refundStatus: 'payments:refund-status',
  autopaySchedule: 'payments:autopay-schedule',
  autopayExecute: 'payments:autopay-execute',
  mandateAuthTimeout: 'payments:mandate-auth-timeout',
  chequeReminder: 'payments:cheque-reminder',
  recoveryNudge: 'payments:recovery-nudge',
  expireLinks: 'payments:expire-links',
  integrityCheck: 'payments:integrity-check',
  purgeWebhookEvents: 'payments:purge-webhook-events',
  refreshCollectionTotals: 'collections:refresh-totals',
} as const;

// ------------------------------------------------------------------ enums (section 7)
export const ORDER_SOURCES = ['PAY_LIST', 'MODULE', 'PAYMENT_LINK', 'AUTOPAY'] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];
export const ALLOCATION_MODES = ['OLDEST_FIRST', 'SELECTED'] as const;
export type AllocationMode = (typeof ALLOCATION_MODES)[number];
export const FEE_MODES = ['SOCIETY_ABSORBS', 'PASS_TO_PAYER'] as const;
export type FeeMode = (typeof FEE_MODES)[number];
export const FEE_METHODS = ['UPI', 'CARD', 'NETBANKING', 'WALLET'] as const;
export type FeeMethod = (typeof FEE_METHODS)[number];
export const ORDER_STATUSES = ['CREATED', 'ATTEMPTED', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ITEM_TYPES = ['INVOICE', 'COLLECTION_REQUEST', 'ADVANCE', 'OLDEST_FIRST_DUES'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const PAYMENT_SOURCES = ['ONLINE', 'AUTOPAY', 'OFFLINE', 'RESIDENT_DECLARED'] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];
export const PAYMENT_METHODS = [
  'UPI',
  'CARD',
  'NETBANKING',
  'WALLET',
  'UPI_AUTOPAY',
  'ENACH',
  'CASH',
  'CHEQUE',
  'NEFT',
  'IMPS',
  'RTGS',
  'UPI_TO_BANK',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_STATUSES = [
  'PENDING_APPROVAL',
  'REJECTED',
  'CAPTURED',
  'FAILED',
  'CONFIRMED',
  'RECEIVED',
  'DEPOSITED',
  'CLEARED',
  'BOUNCED',
  'RETURNED',
  'REVERSED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
/** Statuses whose money counts (`toInvoices + toCollections + toAdvance = amount`, CHECK `ck_payments_split`). */
export const EFFECTIVE_STATUSES: readonly PaymentStatus[] = [
  'CAPTURED',
  'CONFIRMED',
  'RECEIVED',
  'DEPOSITED',
  'CLEARED',
];
export const RECEIPT_STATUSES = ['NONE', 'ISSUED', 'CANCELLED'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];
export const RECEIPT_PDF_STATUSES = ['NONE', 'PENDING', 'READY', 'FAILED'] as const;
export type ReceiptPdfStatus = (typeof RECEIPT_PDF_STATUSES)[number];
export const REVIEW_REASONS = [
  'AMOUNT_MISMATCH',
  'ORDER_CANCELLED',
  'UNKNOWN_ORDER',
  'METHOD_MISMATCH',
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];
export const REVERSAL_REASON_CODES = ['WRONG_ENTRY', 'DUPLICATE_ENTRY', 'CHARGEBACK_LOST', 'OTHER'] as const;
export type ReversalReasonCode = (typeof REVERSAL_REASON_CODES)[number];

export const ALLOC_SOURCES = ['PAYMENT', 'ADVANCE'] as const;
export type AllocSource = (typeof ALLOC_SOURCES)[number];
export const ALLOC_TARGETS = ['INVOICE', 'COLLECTION_REQUEST'] as const;
export type AllocTarget = (typeof ALLOC_TARGETS)[number];
export const ALLOC_REASONS = [
  'ALLOCATED',
  'REALLOCATED',
  'BOUNCED',
  'RETURNED',
  'REVERSED',
  'REFUND_FREED',
  'INVOICE_CANCELLED',
] as const;
export type AllocReason = (typeof ALLOC_REASONS)[number];

export const REFUND_MODES = ['GATEWAY', 'BANK_TRANSFER', 'CHEQUE', 'CASH'] as const;
export type RefundMode = (typeof REFUND_MODES)[number];
export const REFUND_STATUSES = [
  'PENDING_APPROVAL',
  'REJECTED',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'CANCELLED',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const WEBHOOK_STATUSES = [
  'RECEIVED',
  'PROCESSED',
  'IGNORED',
  'FAILED_RETRYABLE',
  'NEEDS_REVIEW',
] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];

export const MANDATE_TYPES = ['UPI_AUTOPAY', 'ENACH'] as const;
export type MandateType = (typeof MANDATE_TYPES)[number];
export const MANDATE_STATUSES = [
  'PENDING_AUTH',
  'ACTIVE',
  'PAUSED',
  'CANCELLED',
  'EXPIRED',
  'FAILED',
] as const;
export type MandateStatus = (typeof MANDATE_STATUSES)[number];
export const MANDATE_END_REASONS = [
  'PAYER_CANCELLED',
  'ADMIN_CANCELLED',
  'UNIT_LINK_ENDED',
  'SOCIETY_CLOSED',
  'GATEWAY_CANCELLED',
  'AUTH_FAILED',
  'AUTH_TIMEOUT',
  'END_DATE',
] as const;
export type MandateEndReason = (typeof MANDATE_END_REASONS)[number];
export const DEBIT_STATUSES = ['SUCCESS', 'FAILED', 'SKIPPED'] as const;
export type DebitStatus = (typeof DEBIT_STATUSES)[number];

export const ADVANCE_ENTRY_TYPES = [
  'PAYMENT_EXCESS',
  'OPENING',
  'APPLIED',
  'ALLOCATION_RELEASED',
  'EXCESS_REVERSED',
  'REFUND_HOLD',
  'REFUND_RELEASE',
] as const;
export type AdvanceEntryType = (typeof ADVANCE_ENTRY_TYPES)[number];
/** Entry types that add to the balance; the others subtract (CHECK `ck_adv_amount`). */
export const ADVANCE_CREDIT_TYPES: readonly AdvanceEntryType[] = [
  'PAYMENT_EXCESS',
  'OPENING',
  'ALLOCATION_RELEASED',
  'REFUND_RELEASE',
];

export const COLLECTION_KINDS = ['FESTIVAL', 'EVENT', 'REPAIR_CALL', 'DONATION', 'OTHER'] as const;
export type CollectionKind = (typeof COLLECTION_KINDS)[number];
export const COLLECTION_AMOUNT_MODES = ['FIXED_PER_UNIT', 'MIN_PER_UNIT', 'VOLUNTARY'] as const;
export type CollectionAmountMode = (typeof COLLECTION_AMOUNT_MODES)[number];
export const AUDIENCE_TYPES = ['ALL', 'BUILDINGS', 'UNITS'] as const;
export type AudienceType = (typeof AUDIENCE_TYPES)[number];
export const PAY_LIST_VISIBILITIES = ['HIDDEN', 'COUNT_ONLY', 'FLATS_ONLY', 'FLATS_AND_AMOUNTS'] as const;
export type PayListVisibility = (typeof PAY_LIST_VISIBILITIES)[number];
export const COLLECTION_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'CHANGES_REQUESTED',
  'APPROVED',
  'REJECTED',
  'PUBLISHED',
  'CLOSED',
  'CANCELLED',
] as const;
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];
export const REQUEST_STATUSES = ['OPEN', 'PART_PAID', 'PAID', 'WAIVED', 'CANCELLED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

// ------------------------------------------------------------------ limits and defaults
/** BR-12-18: per-payment bounds of a collection request (paise). */
export const REQUEST_MIN_PAISE = 100;
export const REQUEST_MAX_PAISE = 10_000_000;
/** BR-12-34: reallocation is refused for payments older than this many days. */
export const REALLOCATE_MAX_AGE_DAYS = 365;
/** BR-12-36: gateway refunds only for payments captured within this many days. */
export const GATEWAY_REFUND_MAX_DAYS = 180;
/** Section 5.11 defaults of settings read by this module. */
export const SETTING_DEFAULTS = {
  'payments.allowPartialPayments': true,
  'payments.allowAdvancePayments': true,
  'billing.receiptPrefix': 'RCT',
  'billing.dueDays': 15,
  'finance.showFinancesToResidents': false,
  'payments.orderExpiryMinutes': 30,
  'payments.paymentLinkExpiryDays': 7,
  'payments.convenienceFeeMode': 'SOCIETY_ABSORBS',
  'payments.convenienceFeeMethods': ['CARD', 'NETBANKING', 'WALLET'],
  'payments.chequeBounceChargePaise': 50_000,
  'payments.chequeBounceBlockCount': 2,
  'payments.lateReturnDays': 30,
  'payments.autoApplyAdvance': true,
  'payments.autopayDebitDaysBeforeDue': 2,
  'payments.treasurerPaymentAlerts': false,
} as const;

// ------------------------------------------------------------------ posting codes (section 6.9)
export const ACCOUNT = {
  bank: 'BANK',
  cashInHand: 'CASH_IN_HAND',
  chequesInClearing: 'CHEQUES_IN_CLEARING',
  gatewayClearing: 'GATEWAY_CLEARING',
  memberReceivable: 'MEMBER_RECEIVABLE',
  memberAdvances: 'MEMBER_ADVANCES',
  collectionFund: 'COLLECTION_FUND',
  gatewayFeeRecovery: 'GATEWAY_FEE_RECOVERY',
} as const;

// ------------------------------------------------------------------ audit actions (section 9.2)
export const AUDIT = {
  orderCreated: 'payments.order.created',
  orderCancelled: 'payments.order.cancelled',
  orderExpired: 'payments.order.expired',
  paymentCaptured: 'payments.payment.captured',
  paymentFailed: 'payments.payment.failed',
  paymentRecorded: 'payments.payment.recorded',
  paymentDeclared: 'payments.payment.declared',
  paymentApproved: 'payments.payment.approved',
  paymentRejected: 'payments.payment.rejected',
  paymentReversed: 'payments.payment.reversed',
  paymentReallocated: 'payments.payment.reallocated',
  paymentDuplicateFlagged: 'payments.payment.duplicate_flagged',
  paymentReviewDone: 'payments.payment.review_done',
  paymentExported: 'payments.payment.exported',
  chequeDeposited: 'payments.cheque.deposited',
  chequeCleared: 'payments.cheque.cleared',
  chequeBounced: 'payments.cheque.bounced',
  chequeReturned: 'payments.cheque.returned',
  receiptIssued: 'payments.receipt.issued',
  receiptCancelled: 'payments.receipt.cancelled',
  receiptResent: 'payments.receipt.resent',
  advanceApplied: 'payments.advance.applied',
  refundRequested: 'payments.refund.requested',
  refundApproved: 'payments.refund.approved',
  refundRejected: 'payments.refund.rejected',
  refundProcessed: 'payments.refund.processed',
  refundFailed: 'payments.refund.failed',
  linkCreated: 'payments.link.created',
  mandateCreated: 'payments.mandate.created',
  mandateActivated: 'payments.mandate.activated',
  mandatePaused: 'payments.mandate.paused',
  mandateResumed: 'payments.mandate.resumed',
  mandateCancelled: 'payments.mandate.cancelled',
  mandateFailed: 'payments.mandate.failed',
  webhookNeedsReview: 'payments.webhook.needs_review',
  collectionCreated: 'collections.collection.created',
  collectionUpdated: 'collections.collection.updated',
  collectionDeleted: 'collections.collection.deleted',
  collectionSubmitted: 'collections.collection.submitted',
  collectionApproved: 'collections.collection.approved',
  collectionRejected: 'collections.collection.rejected',
  collectionChangesRequested: 'collections.collection.changes_requested',
  collectionPublished: 'collections.collection.published',
  collectionReminderSent: 'collections.collection.reminder_sent',
  collectionClosed: 'collections.collection.closed',
  collectionCancelled: 'collections.collection.cancelled',
  collectionStatementDownloaded: 'collections.collection.statement_downloaded',
  requestAdded: 'collections.request.added',
  requestWaived: 'collections.request.waived',
  requestExported: 'collections.request.exported',
} as const;

// ------------------------------------------------------------------ realtime (section 9.3)
export const RT = {
  paymentReceived: 'payment.received',
  paymentReversed: 'payment.reversed',
  chequeUpdated: 'cheque.updated',
  collectionProgress: 'collection.progress',
  paymentStatus: 'payment.status',
} as const;
export const roomFinance = (societyId: number) => `society:${societyId}:finance`;
export const roomPublic = (societyId: number) => `society:${societyId}:public`;

// ------------------------------------------------------------------ notification keys (section 10)
export const NOTIFY = {
  receiptIssued: 'payments.receipt_issued',
  paymentFailed: 'payments.payment_failed',
  checkoutAbandoned: 'payments.checkout_abandoned',
  offlineRejected: 'payments.offline_rejected',
  chequeReceived: 'payments.cheque_received',
  chequeBounced: 'payments.cheque_bounced',
  paymentReversed: 'payments.payment_reversed',
  duplicatePayment: 'payments.duplicate_payment',
  needsReview: 'payments.needs_review',
  refundProcessed: 'payments.refund_processed',
  refundFailed: 'payments.refund_failed',
  paymentLink: 'payments.payment_link',
  mandateActivated: 'payments.mandate_activated',
  mandatePredebit: 'payments.mandate_predebit',
  mandateDebitFailed: 'payments.mandate_debit_failed',
  mandateSkipped: 'payments.mandate_skipped',
  mandateCancelled: 'payments.mandate_cancelled',
  chequeDepositDue: 'payments.cheque_deposit_due',
  treasurerAlert: 'payments.treasurer_alert',
  collectionPublished: 'collections.published',
  collectionReminder: 'collections.reminder',
  collectionClosed: 'collections.closed',
  collectionCancelled: 'collections.cancelled',
} as const;
/** Templates marked T in section 10: still sent while the society is suspended. */
export const TRANSACTIONAL_NOTIFICATIONS: readonly string[] = [
  NOTIFY.receiptIssued,
  NOTIFY.paymentFailed,
  NOTIFY.chequeReceived,
  NOTIFY.chequeBounced,
  NOTIFY.paymentReversed,
  NOTIFY.refundProcessed,
  NOTIFY.paymentLink,
  NOTIFY.mandatePredebit,
  NOTIFY.mandateDebitFailed,
];

// ------------------------------------------------------------------ error codes (section 12)
export const ERR = {
  webhookSignatureInvalid: 'WEBHOOK_SIGNATURE_INVALID',
  unitNotFound: 'UNIT_NOT_FOUND',
  paymentNotFound: 'PAYMENT_NOT_FOUND',
  orderNotFound: 'PAYMENT_ORDER_NOT_FOUND',
  payableNotFound: 'PAYABLE_NOT_FOUND',
  refundNotFound: 'REFUND_NOT_FOUND',
  mandateNotFound: 'MANDATE_NOT_FOUND',
  collectionNotFound: 'COLLECTION_NOT_FOUND',
  requestNotFound: 'COLLECTION_REQUEST_NOT_FOUND',
  linkNotFound: 'PAYMENT_LINK_NOT_FOUND',
  bankAccountNotFound: 'BANK_ACCOUNT_NOT_FOUND',
  fundNotFound: 'FUND_NOT_FOUND',
  invalidState: 'INVALID_STATE',
  staleVersion: 'STALE_VERSION',
  makerChecker: 'MAKER_CHECKER_VIOLATION',
  payableChanged: 'PAYABLE_CHANGED',
  paymentInProgress: 'PAYMENT_IN_PROGRESS',
  duplicateOrder: 'DUPLICATE_ORDER',
  duplicateReference: 'DUPLICATE_REFERENCE',
  duplicatePaymentSuspected: 'DUPLICATE_PAYMENT_SUSPECTED',
  receiptNotReady: 'RECEIPT_NOT_READY',
  paymentNotEffective: 'PAYMENT_NOT_EFFECTIVE',
  refundInProgress: 'REFUND_IN_PROGRESS',
  mandateExists: 'MANDATE_EXISTS',
  collectionTitleExists: 'COLLECTION_TITLE_EXISTS',
  collectionHasPayments: 'COLLECTION_HAS_PAYMENTS',
  linkExpired: 'PAYMENT_LINK_EXPIRED',
  businessRule: 'BUSINESS_RULE_FAILED',
  nothingToPay: 'NOTHING_TO_PAY',
  amountBelowMinimum: 'AMOUNT_BELOW_MINIMUM',
  amountExceedsDue: 'AMOUNT_EXCEEDS_DUE',
  amountTooLarge: 'AMOUNT_TOO_LARGE',
  partialNotAllowed: 'PARTIAL_NOT_ALLOWED',
  advanceNotAllowed: 'ADVANCE_NOT_ALLOWED',
  gatewayNotConfigured: 'GATEWAY_NOT_CONFIGURED',
  methodNotEnabled: 'METHOD_NOT_ENABLED',
  paymentMismatch: 'PAYMENT_MISMATCH',
  paymentDateInvalid: 'PAYMENT_DATE_INVALID',
  cashLimitExceeded: 'CASH_LIMIT_EXCEEDED',
  chequeDateInvalid: 'CHEQUE_DATE_INVALID',
  chequePaymentsBlocked: 'CHEQUE_PAYMENTS_BLOCKED',
  bounceWindowPassed: 'BOUNCE_WINDOW_PASSED',
  reallocationInvalid: 'REALLOCATION_INVALID',
  refundExceedsRefundable: 'REFUND_EXCEEDS_REFUNDABLE',
  refundNeedsReallocation: 'REFUND_NEEDS_REALLOCATION',
  refundModeNotAllowed: 'REFUND_MODE_NOT_ALLOWED',
  advanceInsufficient: 'ADVANCE_INSUFFICIENT',
  autopayNotAvailable: 'AUTOPAY_NOT_AVAILABLE',
  mandateLimitExceeded: 'MANDATE_LIMIT_EXCEEDED',
  mandatoryMustBeFixed: 'MANDATORY_MUST_BE_FIXED',
  collectionDuePast: 'COLLECTION_DUE_DATE_PAST',
  collectionNoAudience: 'COLLECTION_NO_AUDIENCE',
  reminderLimitReached: 'REMINDER_LIMIT_REACHED',
  reminderTooSoon: 'REMINDER_TOO_SOON',
  exportTooLarge: 'EXPORT_TOO_LARGE',
  fileNotLinkable: 'FILE_NOT_LINKABLE',
  periodLocked: 'PERIOD_LOCKED',
  gatewayError: 'GATEWAY_ERROR',
  notImplemented: 'NOT_IMPLEMENTED_IN_FOUNDATION',
} as const;
