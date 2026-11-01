'use strict';
/**
 * Module 06 section 7.3. Money in (gateway, manual), TDS claims and refunds out. `tdsCertificateFileId` and
 * `attachmentFileId` have no foreign key yet: the module 01 `files` table does not exist; a later migration adds them.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE platform_payments (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        invoiceId BIGINT UNSIGNED NULL,
        kind VARCHAR(10) NOT NULL,
        origin VARCHAR(10) NOT NULL,
        status VARCHAR(20) NOT NULL,
        method VARCHAR(20) NULL,
        amountPaise BIGINT NOT NULL,
        appliedPaise BIGINT NOT NULL DEFAULT 0,
        gatewayOrderId VARCHAR(60) NULL,
        gatewayPaymentId VARCHAR(60) NULL,
        gatewayRefundId VARCHAR(60) NULL,
        sourcePaymentId BIGINT UNSIGNED NULL,
        bankReference VARCHAR(40) NULL,
        bankRefKey VARCHAR(64) NULL,
        payerBankName VARCHAR(100) NULL,
        receivedOn DATE NULL,
        tdsSection VARCHAR(10) NULL,
        tdsRatePct DECIMAL(9,4) NULL,
        deductedOn DATE NULL,
        tdsCertificateFileId BIGINT UNSIGNED NULL,
        payeeReference VARCHAR(200) NULL,
        attachmentFileId BIGINT UNSIGNED NULL,
        notes VARCHAR(500) NULL,
        reason VARCHAR(500) NULL,
        failureReason VARCHAR(300) NULL,
        capturedAt DATETIME(3) NULL,
        approvedBy BIGINT UNSIGNED NULL,
        approvedAt DATETIME(3) NULL,
        rejectedReason VARCHAR(500) NULL,
        decidedBy BIGINT UNSIGNED NULL,
        decidedAt DATETIME(3) NULL,
        completedAt DATETIME(3) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_ppay_order (gatewayOrderId),
        UNIQUE KEY uq_ppay_gwpay (gatewayPaymentId),
        UNIQUE KEY uq_ppay_gwrefund (gatewayRefundId),
        UNIQUE KEY uq_ppay_bankref (bankRefKey),
        KEY ix_ppay_society_kind (societyId, kind, status, createdAt),
        KEY ix_ppay_invoice (invoiceId),
        KEY ix_ppay_status_created (status, createdAt),
        KEY ix_ppay_source (sourcePaymentId),
        KEY ix_ppay_approved_by (approvedBy),
        CONSTRAINT fk_ppay_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ppay_invoice FOREIGN KEY (invoiceId) REFERENCES platform_invoices (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ppay_source FOREIGN KEY (sourcePaymentId) REFERENCES platform_payments (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ppay_approved_by FOREIGN KEY (approvedBy) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT ck_ppay_kind CHECK (kind IN ('PAYMENT','TDS','REFUND')),
        CONSTRAINT ck_ppay_origin CHECK (origin IN ('SOCIETY','PLATFORM','GATEWAY','SYSTEM')),
        CONSTRAINT ck_ppay_status CHECK (status IN ('CREATED','CAPTURED','FAILED','EXPIRED','PENDING_APPROVAL','REJECTED','CLAIMED','VERIFIED','PROCESSING','REFUNDED')),
        CONSTRAINT ck_ppay_kind_status CHECK (
          (kind = 'PAYMENT' AND status IN ('CREATED','CAPTURED','FAILED','EXPIRED','PENDING_APPROVAL','REJECTED'))
          OR (kind = 'TDS' AND status IN ('CLAIMED','VERIFIED','REJECTED'))
          OR (kind = 'REFUND' AND status IN ('PENDING_APPROVAL','PROCESSING','REFUNDED','REJECTED','FAILED'))),
        CONSTRAINT ck_ppay_method CHECK (method IS NULL OR method IN ('UPI','CARD','NETBANKING','WALLET','UPI_AUTOPAY','EMANDATE','NEFT','RTGS','IMPS','CHEQUE','DD','TDS','GATEWAY_REFUND','BANK_TRANSFER')),
        CONSTRAINT ck_ppay_amount CHECK (amountPaise > 0),
        CONSTRAINT ck_ppay_applied CHECK (appliedPaise >= 0 AND appliedPaise <= amountPaise),
        CONSTRAINT ck_ppay_tds_invoice CHECK (kind <> 'TDS' OR invoiceId IS NOT NULL),
        CONSTRAINT ck_ppay_tds_section CHECK (tdsSection IS NULL OR (kind = 'TDS' AND tdsSection IN ('194J','194C','OTHER'))),
        CONSTRAINT ck_ppay_tds_rate CHECK (tdsRatePct IS NULL OR (kind = 'TDS' AND tdsRatePct BETWEEN 0 AND 100)),
        CONSTRAINT ck_ppay_deducted_on CHECK (deductedOn IS NULL OR kind = 'TDS'),
        CONSTRAINT ck_ppay_bank_ref_key CHECK (bankRefKey IS NULL OR status <> 'REJECTED')
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS platform_payments');
  },
};
