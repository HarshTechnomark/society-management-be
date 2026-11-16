'use strict';
/**
 * Module 13 section 7.2: journal entries. Posted entries are immutable (BR-13-4): the trigger lets only the reversal columns
 * (`reversedByEntryId`, `reversedAt`, `reversalReason`, once, from NULL) and `updatedAt` change. DELETE is allowed for DRAFT
 * rows only; the retention purge sets the session variable `@accounts_purge = 1` for its own connection to remove the rest.
 * `approvalRequestId` is a plain id until module 14 exists.
 */
const COLS = [
  'societyId',
  'voucherNo',
  'voucherType',
  'entryDate',
  'documentDate',
  'financialYear',
  'narration',
  'refType',
  'refId',
  'linesHash',
  'instrumentRef',
  'source',
  'status',
  'totalPaise',
  'reversalOfId',
  'approvalRequestId',
  'rejectionReason',
  'postedAt',
  'postedBy',
  'version',
  'createdBy',
  'updatedBy',
  'createdAt',
];
module.exports = {
  async up(qi) {
    const q = s => qi.sequelize.query(s);
    // MySQL with binary logging refuses triggers to a user without SUPER (error 1419) unless log_bin_trust_function_creators=1.
    // The model hooks (`journal-entry.model.ts`) enforce the same rules, so the migration continues without the trigger.
    const trigger = async s => {
      try {
        await q(s);
      } catch (err) {
        if (!/SUPER privilege|log_bin_trust_function_creators/.test(String(err && err.message))) throw err;
        process.stderr.write(
          'WARN journal_entries trigger skipped: set log_bin_trust_function_creators=1 and re-run it\n',
        );
      }
    };
    await q(`
      CREATE TABLE journal_entries (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        voucherNo VARCHAR(30) NULL,
        voucherType VARCHAR(30) NOT NULL,
        entryDate DATE NOT NULL,
        documentDate DATE NOT NULL,
        financialYear CHAR(7) NOT NULL,
        narration VARCHAR(500) NOT NULL,
        refType VARCHAR(40) NOT NULL,
        refId VARCHAR(60) NOT NULL,
        linesHash CHAR(64) NOT NULL,
        instrumentRef VARCHAR(60) NULL,
        source VARCHAR(30) NOT NULL,
        status VARCHAR(30) NOT NULL,
        totalPaise BIGINT NOT NULL DEFAULT 0,
        reversalOfId BIGINT UNSIGNED NULL,
        reversedByEntryId BIGINT UNSIGNED NULL,
        reversedAt DATETIME(3) NULL,
        reversalReason VARCHAR(500) NULL,
        approvalRequestId BIGINT UNSIGNED NULL,
        rejectionReason VARCHAR(500) NULL,
        postedAt DATETIME(3) NULL,
        postedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        dedupeKey VARCHAR(102) AS (IF(reversalOfId IS NULL AND status <> 'CANCELLED', CONCAT(refType, ':', refId), NULL)) STORED,
        PRIMARY KEY (id),
        UNIQUE KEY uq_journal_entries_voucher (societyId, voucherNo),
        UNIQUE KEY uq_journal_entries_dedupe (societyId, dedupeKey),
        UNIQUE KEY uq_journal_entries_reversal (reversalOfId),
        KEY ix_journal_entries_date (societyId, status, entryDate),
        KEY ix_journal_entries_ref (societyId, refType, refId),
        KEY ix_journal_entries_instrument (societyId, instrumentRef),
        KEY ix_journal_entries_reversed (reversedByEntryId),
        CONSTRAINT fk_journal_entries_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_journal_entries_reversal_of FOREIGN KEY (reversalOfId) REFERENCES journal_entries (id) ON DELETE RESTRICT,
        CONSTRAINT fk_journal_entries_reversed_by FOREIGN KEY (reversedByEntryId) REFERENCES journal_entries (id) ON DELETE RESTRICT,
        CONSTRAINT ck_journal_entries_voucher_type CHECK (voucherType IN ('RECEIPT','PAYMENT','CONTRA','JOURNAL','INVOICE','DEBIT_NOTE','CREDIT_NOTE','WRITE_OFF','OPENING_BALANCE','CLOSING')),
        CONSTRAINT ck_journal_entries_source CHECK (source IN ('SYSTEM','MANUAL')),
        CONSTRAINT ck_journal_entries_status CHECK (status IN ('DRAFT','PENDING_APPROVAL','POSTED','REJECTED','CANCELLED')),
        CONSTRAINT ck_journal_entries_posted CHECK (status <> 'POSTED' OR (voucherNo IS NOT NULL AND totalPaise > 0 AND postedAt IS NOT NULL))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    const same = COLS.map(c => `NEW.${c} <=> OLD.${c}`).join(' AND ');
    await trigger(`
      CREATE TRIGGER trg_journal_entries_immutable BEFORE UPDATE ON journal_entries FOR EACH ROW
      BEGIN
        IF OLD.status = 'POSTED' AND NOT (OLD.reversedByEntryId IS NULL AND ${same}) THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'journal_entries: a posted entry is immutable';
        END IF;
      END`);
    await trigger(`
      CREATE TRIGGER trg_journal_entries_no_delete BEFORE DELETE ON journal_entries FOR EACH ROW
      BEGIN
        IF OLD.status <> 'DRAFT' AND COALESCE(@accounts_purge, 0) <> 1 THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'journal_entries: only a draft entry can be deleted';
        END IF;
      END`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TRIGGER IF EXISTS trg_journal_entries_immutable');
    await qi.sequelize.query('DROP TRIGGER IF EXISTS trg_journal_entries_no_delete');
    await qi.sequelize.query('DROP TABLE IF EXISTS journal_entries');
  },
};
