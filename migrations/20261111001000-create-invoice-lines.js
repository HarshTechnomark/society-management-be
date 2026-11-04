'use strict';
/**
 * Module 11 section 7 (billing): invoice_lines. Financial rows have no database FK to `units`, `residents` or `files` (BR-05-21: they
 * are kept after closure while modules 08/09 purge their own rows); those columns are indexed BIGINT snapshots.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE invoice_lines (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        invoiceId BIGINT UNSIGNED NULL,
        billingNoteId BIGINT UNSIGNED NULL,
        lineNo SMALLINT UNSIGNED NOT NULL,
        lineKind VARCHAR(12) NOT NULL,
        chargeHeadId BIGINT UNSIGNED NULL,
        headKey VARCHAR(40) NULL,
        description VARCHAR(300) NOT NULL,
        quantity DECIMAL(14,4) NULL,
        ratePaise BIGINT NULL,
        amountPaise BIGINT NOT NULL,
        isTaxable BOOLEAN NOT NULL DEFAULT false,
        billingRuleVersionId BIGINT UNSIGNED NULL,
        periodFrom DATE NULL,
        periodTo DATE NULL,
        prorationDays SMALLINT UNSIGNED NULL,
        periodDays SMALLINT UNSIGNED NULL,
        refInvoiceLineId BIGINT UNSIGNED NULL,
        computation JSON NULL,
        ledgerAccountCode VARCHAR(40) NOT NULL,
        creditedPaise BIGINT NOT NULL DEFAULT 0,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_lines_invoice (invoiceId, lineNo),
        UNIQUE KEY uq_lines_note (billingNoteId, lineNo),
        KEY ix_lines_society (societyId),
        KEY ix_lines_head (societyId, chargeHeadId),
        KEY ix_lines_ref (refInvoiceLineId),
        KEY ix_lines_version (billingRuleVersionId),
        CONSTRAINT fk_lines_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_lines_invoice FOREIGN KEY (invoiceId) REFERENCES invoices (id) ON DELETE RESTRICT,
        CONSTRAINT fk_lines_note FOREIGN KEY (billingNoteId) REFERENCES billing_notes (id) ON DELETE RESTRICT,
        CONSTRAINT fk_lines_head FOREIGN KEY (chargeHeadId) REFERENCES charge_heads (id) ON DELETE RESTRICT,
        CONSTRAINT fk_lines_version FOREIGN KEY (billingRuleVersionId) REFERENCES billing_rule_versions (id) ON DELETE RESTRICT,
        CONSTRAINT fk_lines_ref FOREIGN KEY (refInvoiceLineId) REFERENCES invoice_lines (id) ON DELETE RESTRICT,
        CONSTRAINT ck_lines_parent CHECK ((invoiceId IS NULL) <> (billingNoteId IS NULL)),
        CONSTRAINT ck_lines_kind CHECK (lineKind IN ('CHARGE','INTEREST','LATE_FEE','CGST','SGST','ROUND_OFF','WRITE_OFF')),
        CONSTRAINT ck_lines_head CHECK (lineKind NOT IN ('CHARGE','INTEREST','LATE_FEE') OR chargeHeadId IS NOT NULL),
        CONSTRAINT ck_lines_amount CHECK ((lineKind = 'ROUND_OFF' AND amountPaise <> 0) OR (lineKind <> 'ROUND_OFF' AND amountPaise > 0)),
        CONSTRAINT ck_lines_credited CHECK (creditedPaise >= 0 AND creditedPaise <= ABS(amountPaise))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS invoice_lines');
  },
};
