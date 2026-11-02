'use strict';
/** Module 06 section 7.4. Append-only credit balance ledger per society (BR-06-25). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE platform_credits (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        entryType VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'POSTED',
        amountPaise BIGINT NOT NULL,
        balanceAfterPaise BIGINT NULL,
        invoiceId BIGINT UNSIGNED NULL,
        paymentId BIGINT UNSIGNED NULL,
        reason VARCHAR(500) NULL,
        postedAt DATETIME(3) NULL,
        approvedBy BIGINT UNSIGNED NULL,
        approvedAt DATETIME(3) NULL,
        rejectedReason VARCHAR(500) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        KEY ix_pcred_society_posted (societyId, status, postedAt, id),
        KEY ix_pcred_invoice (invoiceId),
        KEY ix_pcred_payment (paymentId),
        KEY ix_pcred_approved_by (approvedBy),
        CONSTRAINT fk_pcred_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_pcred_invoice FOREIGN KEY (invoiceId) REFERENCES platform_invoices (id) ON DELETE RESTRICT,
        CONSTRAINT fk_pcred_payment FOREIGN KEY (paymentId) REFERENCES platform_payments (id) ON DELETE RESTRICT,
        CONSTRAINT fk_pcred_approved_by FOREIGN KEY (approvedBy) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT ck_pcred_entry_type CHECK (entryType IN ('GOODWILL','PAYMENT_EXCESS','CREDIT_NOTE','APPLIED','REFUND','REFUND_REVERSED')),
        CONSTRAINT ck_pcred_status CHECK (status IN ('PENDING_APPROVAL','POSTED','REJECTED')),
        CONSTRAINT ck_pcred_pending CHECK (status <> 'PENDING_APPROVAL' OR entryType = 'GOODWILL'),
        CONSTRAINT ck_pcred_amount CHECK (
          (entryType IN ('GOODWILL','PAYMENT_EXCESS','CREDIT_NOTE','REFUND_REVERSED') AND amountPaise > 0)
          OR (entryType IN ('APPLIED','REFUND') AND amountPaise < 0)),
        CONSTRAINT ck_pcred_balance CHECK (balanceAfterPaise IS NULL OR balanceAfterPaise >= 0),
        CONSTRAINT ck_pcred_posted_balance CHECK (status <> 'POSTED' OR balanceAfterPaise IS NOT NULL),
        CONSTRAINT ck_pcred_goodwill_reason CHECK (entryType <> 'GOODWILL' OR (reason IS NOT NULL AND CHAR_LENGTH(reason) >= 10))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS platform_credits');
  },
};
