'use strict';
/**
 * Module 11 section 7 (billing): billing_notes. Financial rows have no database FK to `units`, `residents` or `files` (BR-05-21: they
 * are kept after closure while modules 08/09 purge their own rows); those columns are indexed BIGINT snapshots.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE billing_notes (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        noteType VARCHAR(6) NOT NULL,
        noteNo VARCHAR(30) NULL,
        financialYear CHAR(7) NULL,
        invoiceId BIGINT UNSIGNED NOT NULL,
        unitId BIGINT UNSIGNED NOT NULL,
        billToResidentId BIGINT UNSIGNED NOT NULL,
        billToName VARCHAR(150) NOT NULL,
        reasonCode VARCHAR(20) NOT NULL,
        status VARCHAR(18) NOT NULL,
        approvalType VARCHAR(20) NULL,
        approvalRequestId BIGINT UNSIGNED NULL,
        noteDate DATE NULL,
        subtotalPaise BIGINT NOT NULL DEFAULT 0,
        cgstPaise BIGINT NOT NULL DEFAULT 0,
        sgstPaise BIGINT NOT NULL DEFAULT 0,
        taxPaise BIGINT NOT NULL DEFAULT 0,
        roundOffPaise BIGINT NOT NULL DEFAULT 0,
        totalPaise BIGINT NOT NULL,
        appliedToInvoicePaise BIGINT NOT NULL DEFAULT 0,
        excessToAdvancePaise BIGINT NOT NULL DEFAULT 0,
        interestFromDate DATE NULL,
        interestToDate DATE NULL,
        lateFeePolicyId BIGINT UNSIGNED NULL,
        dedupeKey VARCHAR(80) NULL,
        remarks VARCHAR(500) NOT NULL,
        rejectedReason VARCHAR(500) NULL,
        issuedAt DATETIME(3) NULL,
        pdfFileId BIGINT UNSIGNED NULL,
        pdfStatus VARCHAR(10) NOT NULL DEFAULT 'PENDING',
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_notes_no (societyId, noteNo),
        UNIQUE KEY uq_notes_dedupe (societyId, dedupeKey),
        KEY ix_notes_invoice (societyId, invoiceId, status),
        KEY ix_notes_unit (societyId, unitId, noteDate),
        KEY ix_notes_status (societyId, noteType, status),
        KEY ix_notes_policy (lateFeePolicyId),
        CONSTRAINT fk_notes_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_notes_invoice FOREIGN KEY (invoiceId) REFERENCES invoices (id) ON DELETE RESTRICT,
        CONSTRAINT fk_notes_policy FOREIGN KEY (lateFeePolicyId) REFERENCES late_fee_policies (id) ON DELETE RESTRICT,
        CONSTRAINT ck_notes_type CHECK (noteType IN ('CREDIT','DEBIT')),
        CONSTRAINT ck_notes_reason CHECK (reasonCode IN ('BILLING_ERROR','WAIVER','DISPUTE_RESOLUTION','CANCELLATION','WRITE_OFF','SOURCE_REFUND','INTEREST','LATE_FEE','ADDITIONAL_CHARGE','OTHER')),
        CONSTRAINT ck_notes_reason_type CHECK ((noteType = 'CREDIT' AND reasonCode IN ('BILLING_ERROR','WAIVER','DISPUTE_RESOLUTION','CANCELLATION','WRITE_OFF','SOURCE_REFUND','OTHER')) OR (noteType = 'DEBIT' AND reasonCode IN ('INTEREST','LATE_FEE','ADDITIONAL_CHARGE','BILLING_ERROR','OTHER'))),
        CONSTRAINT ck_notes_status CHECK (status IN ('PENDING_APPROVAL','CHANGES_REQUESTED','ISSUED','REJECTED')),
        CONSTRAINT ck_notes_debit_issued CHECK (noteType <> 'DEBIT' OR status = 'ISSUED'),
        CONSTRAINT ck_notes_issued_no CHECK (status <> 'ISSUED' OR (noteNo IS NOT NULL AND noteDate IS NOT NULL)),
        CONSTRAINT ck_notes_approval CHECK (approvalType IS NULL OR (noteType = 'CREDIT' AND approvalType IN ('CREDIT_NOTE','INVOICE_CANCEL','WRITE_OFF'))),
        CONSTRAINT ck_notes_amounts CHECK (subtotalPaise >= 0 AND cgstPaise >= 0 AND sgstPaise = cgstPaise),
        CONSTRAINT ck_notes_round CHECK (roundOffPaise BETWEEN -49 AND 50 AND (noteType = 'DEBIT' OR roundOffPaise = 0)),
        CONSTRAINT ck_notes_total CHECK (totalPaise > 0),
        CONSTRAINT ck_notes_split CHECK (appliedToInvoicePaise >= 0 AND excessToAdvancePaise >= 0),
        CONSTRAINT ck_notes_pdf CHECK (pdfStatus IN ('PENDING','READY','FAILED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS billing_notes');
  },
};
