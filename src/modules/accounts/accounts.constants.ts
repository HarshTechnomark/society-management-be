/**
 * Names, enums, limits and keys of module 13 (sections 2, 5, 7, 9, 10 and 12). The enums are shared with the migrations'
 * CHECKs and with Zod (`z.enum(X)`); keep the lists identical.
 */
export const ACCOUNTS_QUEUE = 'accounts';

/** Section 2.1 permission keys. */
export const PERM = {
  accountsView: 'finance.accounts.view',
  accountsCreate: 'finance.accounts.create',
  accountsEdit: 'finance.accounts.edit',
  accountsExport: 'finance.accounts.export',
  accountsApprove: 'finance.accounts.approve',
  expensesView: 'finance.expenses.view',
  expensesCreate: 'finance.expenses.create',
  expensesEdit: 'finance.expenses.edit',
  expensesDelete: 'finance.expenses.delete',
  expensesExport: 'finance.expenses.export',
  expensesApprove: 'finance.expenses.approve',
  bankView: 'finance.bank.view',
  bankEdit: 'finance.bank.edit',
  bankImport: 'finance.bank.import',
  bankApprove: 'finance.bank.approve',
  residentFinancesView: 'resident.finances.view',
  residentDuesView: 'resident.dues.view',
} as const;

/** Section 2.2 entitlement keys. */
export const ENT = {
  liveBalance: 'accounting.live_society_balance',
  fundBalances: 'accounting.collection_and_fund_balances',
  cashBook: 'accounting.simple_cash_book',
  deposits: 'accounting.deposits_ledger',
  settlements: 'payments.settlement_reconciliation',
  statementImport: 'payments.bank_statement_import',
  bankReconciliation: 'accounting.bank_reconciliation',
  chartOfAccounts: 'accounting.chart_of_accounts',
  journalEngine: 'accounting.journal_engine',
  manualJournals: 'accounting.manual_journals',
  openingBalanceImport: 'accounting.opening_balance_import',
  funds: 'accounting.funds',
  expenses: 'accounting.expenses',
  vendorPayments: 'accounting.vendor_payments',
  tds: 'accounting.tds',
  gstSummary: 'accounting.gst_summary',
  bankAndCashAccounts: 'accounting.bank_and_cash_accounts',
  pettyCash: 'accounting.petty_cash',
  financialReports: 'accounting.financial_reports',
  periodsAndLocking: 'accounting.periods_and_locking',
  yearEndClosing: 'accounting.year_end_closing',
  transparencyDashboard: 'accounting.transparency_dashboard',
} as const;

/** Section 9.3: module 14 approval types of this module (`MANUAL_JOURNAL`, `FUND_TRANSFER` and `PERIOD_UNLOCK` are new there). */
export const APPROVAL_TYPES = {
  expense: 'EXPENSE',
  manualJournal: 'MANUAL_JOURNAL',
  fundTransfer: 'FUND_TRANSFER',
  periodUnlock: 'PERIOD_UNLOCK',
  depositRefund: 'DEPOSIT_REFUND',
} as const;
/** Entity types used with `approvals.request` / `lockOpenForEntity`. */
export const ENTITY = {
  expense: 'expense',
  journalEntry: 'journal_entry',
  fund: 'fund',
  societyBalance: 'society_balance',
  deposit: 'deposit',
} as const;

/** Section 9.1 jobs of queue `accounts`. */
export const JOBS = {
  balanceVerify: 'accounts:balance-verify',
  settlementReconcile: 'accounts:settlement-reconcile',
  statementParse: 'accounts:statement-parse',
  autoMatch: 'accounts:auto-match',
  clearingAge: 'accounts:clearing-age',
  depositSync: 'accounts:deposit-sync',
  relock: 'accounts:relock',
  yearClose: 'accounts:year-close',
  reportExport: 'accounts:report-export',
} as const;

// ------------------------------------------------------------------ enums (section 7)
export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'FUND', 'INCOME', 'EXPENSE'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const ACCOUNT_SUBTYPES = [
  'BANK',
  'CASH',
  'PETTY_CASH',
  'CLEARING',
  'CHEQUES',
  'INVESTMENT',
  'RECEIVABLE',
  'PAYABLE',
  'DEPOSIT',
  'TAX',
  'FUND',
  'SURPLUS',
  'OPENING',
  'OTHER',
] as const;
export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[number];

export const VOUCHER_TYPES = [
  'RECEIPT',
  'PAYMENT',
  'CONTRA',
  'JOURNAL',
  'INVOICE',
  'DEBIT_NOTE',
  'CREDIT_NOTE',
  'WRITE_OFF',
  'OPENING_BALANCE',
  'CLOSING',
] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];
/** BR-13-7: which module 01 number series a voucher type draws from. */
export const VOUCHER_SERIES: Record<VoucherType, 'VOUCHER' | 'JOURNAL'> = {
  RECEIPT: 'VOUCHER',
  PAYMENT: 'VOUCHER',
  CONTRA: 'VOUCHER',
  JOURNAL: 'JOURNAL',
  INVOICE: 'JOURNAL',
  DEBIT_NOTE: 'JOURNAL',
  CREDIT_NOTE: 'JOURNAL',
  WRITE_OFF: 'JOURNAL',
  OPENING_BALANCE: 'JOURNAL',
  CLOSING: 'JOURNAL',
};
export const JOURNAL_SOURCES = ['SYSTEM', 'MANUAL'] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];
export const JOURNAL_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REJECTED', 'CANCELLED'] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];
export const BALANCE_DIRECTIONS = ['IN', 'OUT', 'MOVE', 'FUND_ONLY'] as const;
export type BalanceDirection = (typeof BALANCE_DIRECTIONS)[number];

export const FUND_TYPES = ['SINKING', 'REPAIR', 'CORPUS', 'COLLECTION', 'CUSTOM'] as const;
export type FundType = (typeof FUND_TYPES)[number];
export const FUND_STATUSES = ['ACTIVE', 'CLOSED'] as const;
export type FundStatus = (typeof FUND_STATUSES)[number];

export const EXPENSE_TYPES = ['DIRECT', 'VENDOR_BILL', 'STATUTORY_DUE'] as const;
export type ExpenseType = (typeof EXPENSE_TYPES)[number];
export const EXPENSE_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'CHANGES_REQUESTED',
  'POSTED',
  'REJECTED',
  'CANCELLED',
  'REVERSED',
] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];
export const EXPENSE_PAYMENT_MODES = [
  'CASH',
  'UPI',
  'NEFT',
  'RTGS',
  'IMPS',
  'CHEQUE',
  'DEBIT_CARD',
  'AUTO_DEBIT',
] as const;
export type ExpensePaymentMode = (typeof EXPENSE_PAYMENT_MODES)[number];

export const BANK_ACCOUNT_KINDS = ['CURRENT', 'SAVINGS'] as const;
export type BankAccountKind = (typeof BANK_ACCOUNT_KINDS)[number];
export const STATEMENT_FORMATS = [
  'GENERIC_CSV',
  'HDFC_CSV',
  'ICICI_CSV',
  'SBI_XLSX',
  'AXIS_CSV',
  'KOTAK_CSV',
  'GENERIC_XLSX',
] as const;
export type StatementFormat = (typeof STATEMENT_FORMATS)[number];
export const VERIFICATION_STATUSES = ['UNVERIFIED', 'VERIFIED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export const BANK_ACCOUNT_STATUSES = ['ACTIVE', 'CLOSED'] as const;
export type BankAccountStatus = (typeof BANK_ACCOUNT_STATUSES)[number];

export const SETTLEMENT_SOURCES = ['REPORT_UPLOAD', 'GATEWAY_FETCH'] as const;
export type SettlementSource = (typeof SETTLEMENT_SOURCES)[number];
export const SETTLEMENT_STATUSES = ['RECEIVED', 'MISMATCH', 'POSTED'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const STATEMENT_FILE_FORMATS = ['CSV', 'XLSX'] as const;
export type StatementFileFormat = (typeof STATEMENT_FILE_FORMATS)[number];
export const STATEMENT_IMPORT_STATUSES = ['UPLOADED', 'PARSED', 'FAILED', 'RECONCILED'] as const;
export type StatementImportStatus = (typeof STATEMENT_IMPORT_STATUSES)[number];
export const MATCH_STATUSES = ['UNMATCHED', 'MATCHED', 'IGNORED'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];
export const MATCH_METHODS = ['AUTO_REFERENCE', 'AUTO_AMOUNT_DATE', 'MANUAL', 'CREATED_ENTRY'] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];

export const DEPOSIT_KINDS = ['MOVE', 'RENOVATION', 'AMENITY', 'ACCESS_CARD', 'KEY', 'OTHER'] as const;
export type DepositKind = (typeof DEPOSIT_KINDS)[number];
export const DEPOSIT_STATUSES = [
  'AWAITING_PAYMENT',
  'HELD',
  'REFUND_PENDING',
  'REFUND_APPROVED',
  'REFUNDED',
  'FORFEITED',
  'CANCELLED',
] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];
export const DEPOSIT_REFUND_MODES = ['CASH', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'CHEQUE'] as const;
export type DepositRefundMode = (typeof DEPOSIT_REFUND_MODES)[number];
/** BR-13-45 / 7.13: the deposit ledger a kind posts to. */
export const DEPOSIT_LEDGER: Record<DepositKind, string> = {
  RENOVATION: '2510',
  MOVE: '2520',
  AMENITY: '2530',
  ACCESS_CARD: '2540',
  KEY: '2540',
  OTHER: '2550',
};

// ------------------------------------------------------------------ limits (BR-13-1 and friends)
export const MAX_LINE_PAISE = 10_000_000_000_000;
export const MAX_JOURNAL_LINES = 200;
export const CHART_TEMPLATE_VERSION = 1;
/** BR-13-20 / BR-13-24 setting defaults read by the parts (`finance.*`). */
export const SETTING_DEFAULTS = {
  'finance.showFinancesToResidents': false,
  'finance.gstInputClaimable': false,
  'finance.expenseBackdateDays': 90,
  'finance.billRequiredAbovePaise': 200_000,
  'finance.autoMatchWindowDays': 3,
  'finance.clearingAlertDays': 3,
  'finance.maxUnlockHours': 72,
} as const;

// ------------------------------------------------------------------ ledger codes (section 7.13) and system keys (7.15)
/** Stable codes other modules post to. */
export const CODE = {
  cashInHand: '1120',
  pettyCash: '1130',
  gatewayClearing: '1140',
  chequesInClearing: '1150',
  bankGroup: '1110',
  memberReceivable: '1300',
  gstInput: '1410',
  vendorPayable: '2110',
  tdsPayable: '2140',
  memberAdvances: '2210',
  outputCgst: '2310',
  outputSgst: '2320',
  outputIgst: '2330',
  sinkingFund: '2410',
  repairFund: '2420',
  corpusFund: '2430',
  collectionFundsGroup: '2440',
  customFundsGroup: '2450',
  suspense: '2690',
  surplus: '3100',
  openingAdjustment: '3900',
  maintenanceIncome: '4100',
  gatewayFeeRecovery: '4310',
  depositDeductions: '4600',
  fundTransferIn: '4900',
  roundOff: '4990',
  bankCharges: '5600',
  gatewayCharges: '5610',
  badDebts: '5900',
} as const;

/** Section 7.15: alias → seeded code. `BANK` and `COLLECTION_FUND` are resolved by the engine (collection account, line fund). */
export const SYSTEM_KEYS: Record<string, string> = {
  GATEWAY_CLEARING: CODE.gatewayClearing,
  CASH_IN_HAND: CODE.cashInHand,
  PETTY_CASH: CODE.pettyCash,
  CHEQUES_IN_CLEARING: CODE.chequesInClearing,
  MEMBER_RECEIVABLE: CODE.memberReceivable,
  MEMBER_ADVANCES: CODE.memberAdvances,
  GATEWAY_FEE_RECOVERY: CODE.gatewayFeeRecovery,
  GATEWAY_CHARGES: CODE.gatewayCharges,
  GST_INPUT: CODE.gstInput,
  TDS_PAYABLE: CODE.tdsPayable,
  VENDOR_PAYABLE: CODE.vendorPayable,
  SUSPENSE: CODE.suspense,
  SURPLUS: CODE.surplus,
  OPENING_ADJUSTMENT: CODE.openingAdjustment,
  ROUND_OFF: CODE.roundOff,
};
export const KEY_BANK = 'BANK';
export const KEY_COLLECTION_FUND = 'COLLECTION_FUND';

// ------------------------------------------------------------------ audit actions (section 9.2)
export const AUDIT = {
  journalPosted: 'accounts.journal.posted',
  journalDrafted: 'accounts.journal.drafted',
  journalUpdated: 'accounts.journal.updated',
  journalSubmitted: 'accounts.journal.submitted',
  journalRejected: 'accounts.journal.rejected',
  journalCancelled: 'accounts.journal.cancelled',
  journalReversed: 'accounts.journal.reversed',
  booksSeeded: 'accounts.books.seeded',
  openingBalancePosted: 'accounts.opening_balance.posted',
  ledgerAccountCreated: 'accounts.ledger_account.created',
  ledgerAccountUpdated: 'accounts.ledger_account.updated',
  expenseCreated: 'accounts.expense.created',
  expenseUpdated: 'accounts.expense.updated',
  expenseSubmitted: 'accounts.expense.submitted',
  expensePosted: 'accounts.expense.posted',
  expenseRejected: 'accounts.expense.rejected',
  expenseWithdrawn: 'accounts.expense.withdrawn',
  expenseCancelled: 'accounts.expense.cancelled',
  expenseReversed: 'accounts.expense.reversed',
  expenseExported: 'accounts.expense.exported',
  fundCreated: 'accounts.fund.created',
  fundUpdated: 'accounts.fund.updated',
  fundClosed: 'accounts.fund.closed',
  fundTransferRequested: 'accounts.fund_transfer.requested',
  fundTransferPosted: 'accounts.fund_transfer.posted',
  bankAccountCreated: 'accounts.bank_account.created',
  bankAccountUpdated: 'accounts.bank_account.updated',
  bankAccountVerified: 'accounts.bank_account.verified',
  bankAccountCollectionSet: 'accounts.bank_account.collection_set',
  bankAccountClosed: 'accounts.bank_account.closed',
  bankAccountRevealed: 'accounts.bank_account.revealed',
  settlementReceived: 'accounts.settlement.received',
  settlementPosted: 'accounts.settlement.posted',
  settlementMismatched: 'accounts.settlement.mismatched',
  settlementDifferenceAccepted: 'accounts.settlement.difference_accepted',
  statementImported: 'accounts.statement.imported',
  statementAutoMatched: 'accounts.statement.auto_matched',
  statementLineMatched: 'accounts.statement_line.matched',
  statementLineUnmatched: 'accounts.statement_line.unmatched',
  statementLineIgnored: 'accounts.statement_line.ignored',
  statementLineEntryCreated: 'accounts.statement_line.entry_created',
  statementReconciled: 'accounts.statement.reconciled',
  depositCreated: 'accounts.deposit.created',
  depositReceived: 'accounts.deposit.received',
  depositDeducted: 'accounts.deposit.deducted',
  depositForfeited: 'accounts.deposit.forfeited',
  depositRefundRequested: 'accounts.deposit.refund_requested',
  depositRefundApproved: 'accounts.deposit.refund_approved',
  depositRefundRejected: 'accounts.deposit.refund_rejected',
  depositRefunded: 'accounts.deposit.refunded',
  depositCancelled: 'accounts.deposit.cancelled',
  periodLocked: 'accounts.period.locked',
  periodUnlockRequested: 'accounts.period.unlock_requested',
  periodUnlocked: 'accounts.period.unlocked',
  periodRelocked: 'accounts.period.relocked',
  financialYearClosed: 'accounts.financial_year.closed',
  reportExported: 'accounts.report.exported',
  balanceDriftCorrected: 'accounts.balance.drift_corrected',
} as const;

// ------------------------------------------------------------------ realtime (section 9.4)
export const RT = {
  balanceUpdated: 'balance.updated',
  expenseUpdated: 'expense.updated',
  settlementUpdated: 'settlement.updated',
  statementUpdated: 'statement.updated',
  depositUpdated: 'deposit.updated',
} as const;
export const roomFinance = (societyId: number) => `society:${societyId}:finance`;
export const roomPublic = (societyId: number) => `society:${societyId}:public`;
export const roomUnit = (unitId: number) => `unit:${unitId}`;

// ------------------------------------------------------------------ notification templates (section 10)
export const NOTIFY = {
  expenseReversed: 'accounts.expense_reversed',
  journalRejected: 'accounts.journal_rejected',
  bankAccountChanged: 'accounts.bank_account_changed',
  bankAccountVerified: 'accounts.bank_account_verified',
  settlementMismatch: 'accounts.settlement_mismatch',
  clearingAged: 'accounts.clearing_aged',
  statementImported: 'accounts.statement_imported',
  balanceDrift: 'accounts.balance_drift',
  periodLocked: 'accounts.period_locked',
  periodUnlocked: 'accounts.period_unlocked',
  yearClosed: 'accounts.year_closed',
  depositReceived: 'accounts.deposit_received',
  depositDeducted: 'accounts.deposit_deducted',
  depositRefunded: 'accounts.deposit_refunded',
  exportReady: 'accounts.export_ready',
} as const;

// ------------------------------------------------------------------ error codes (section 12)
export const ERR = {
  journalNotFound: 'JOURNAL_NOT_FOUND',
  expenseNotFound: 'EXPENSE_NOT_FOUND',
  ledgerAccountNotFound: 'LEDGER_ACCOUNT_NOT_FOUND',
  fundNotFound: 'FUND_NOT_FOUND',
  bankAccountNotFound: 'BANK_ACCOUNT_NOT_FOUND',
  settlementNotFound: 'SETTLEMENT_NOT_FOUND',
  statementNotFound: 'STATEMENT_NOT_FOUND',
  statementLineNotFound: 'STATEMENT_LINE_NOT_FOUND',
  depositNotFound: 'DEPOSIT_NOT_FOUND',
  periodLocked: 'PERIOD_LOCKED',
  journalDuplicateRef: 'JOURNAL_DUPLICATE_REF',
  journalImmutable: 'JOURNAL_IMMUTABLE',
  journalAlreadyReversed: 'JOURNAL_ALREADY_REVERSED',
  duplicateLedgerCode: 'DUPLICATE_LEDGER_CODE',
  duplicateFundName: 'DUPLICATE_FUND_NAME',
  duplicateBankAccount: 'DUPLICATE_BANK_ACCOUNT',
  settlementAlreadyPosted: 'SETTLEMENT_ALREADY_POSTED',
  statementAlreadyImported: 'STATEMENT_ALREADY_IMPORTED',
  lineAlreadyMatched: 'LINE_ALREADY_MATCHED',
  journalLineAlreadyMatched: 'JOURNAL_LINE_ALREADY_MATCHED',
  unlockAlreadyActive: 'UNLOCK_ALREADY_ACTIVE',
  yearAlreadyClosed: 'YEAR_ALREADY_CLOSED',
  journalNotBalanced: 'JOURNAL_NOT_BALANCED',
  journalLineInvalid: 'JOURNAL_LINE_INVALID',
  unknownLedgerCode: 'UNKNOWN_LEDGER_CODE',
  accountNotPostable: 'ACCOUNT_NOT_POSTABLE',
  accountInactive: 'ACCOUNT_INACTIVE',
  reversalNotAllowed: 'REVERSAL_NOT_ALLOWED',
  fundInactive: 'FUND_INACTIVE',
  fundBalanceInsufficient: 'FUND_BALANCE_INSUFFICIENT',
  fundBalanceNotZero: 'FUND_BALANCE_NOT_ZERO',
  fundTransferSameFund: 'FUND_TRANSFER_SAME_FUND',
  insufficientBalance: 'INSUFFICIENT_BALANCE',
  billRequired: 'BILL_REQUIRED',
  invalidExpenseHead: 'INVALID_EXPENSE_HEAD',
  invalidPaymentSource: 'INVALID_PAYMENT_SOURCE',
  dateOutOfRange: 'DATE_OUT_OF_RANGE',
  vendorBillNotPayable: 'VENDOR_BILL_NOT_PAYABLE',
  systemAccountLocked: 'SYSTEM_ACCOUNT_LOCKED',
  accountBalanceNotZero: 'ACCOUNT_BALANCE_NOT_ZERO',
  invalidParent: 'INVALID_PARENT',
  bankAccountLimit: 'BANK_ACCOUNT_LIMIT',
  bankBalanceNotZero: 'BANK_BALANCE_NOT_ZERO',
  collectionAccountRequired: 'COLLECTION_ACCOUNT_REQUIRED',
  settlementTotalsInvalid: 'SETTLEMENT_TOTALS_INVALID',
  settlementMismatch: 'SETTLEMENT_MISMATCH',
  statementParseFailed: 'STATEMENT_PARSE_FAILED',
  matchAmountMismatch: 'MATCH_AMOUNT_MISMATCH',
  matchWrongAccount: 'MATCH_WRONG_ACCOUNT',
  reconciliationIncomplete: 'RECONCILIATION_INCOMPLETE',
  depositInsufficientHeld: 'DEPOSIT_INSUFFICIENT_HELD',
  lockDateInvalid: 'LOCK_DATE_INVALID',
  lockPreconditionFailed: 'LOCK_PRECONDITION_FAILED',
  yearClosePrecondition: 'YEAR_CLOSE_PRECONDITION',
  fileNotLinkable: 'FILE_NOT_LINKABLE',
  // standard codes this module uses
  invalidState: 'INVALID_STATE',
  staleVersion: 'STALE_VERSION',
  makerChecker: 'MAKER_CHECKER_VIOLATION',
  notImplemented: 'NOT_IMPLEMENTED_IN_FOUNDATION',
} as const;
