'use strict';
/** Module 12 section 7.4: refunds. `openSlot` (generated) allows one open refund per payment (BR-12-35). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE refunds (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        refundNo VARCHAR(30) NULL,
        unitId BIGINT UNSIGNED NOT NULL,
        paymentId BIGINT UNSIGNED NOT NULL,
        amountPaise BIGINT NOT NULL,
        freedFromAllocationsPaise BIGINT NOT NULL DEFAULT 0,
        mode VARCHAR(15) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING_APPROVAL',
        reason VARCHAR(500) NOT NULL,
        payeeName VARCHAR(120) NULL,
        payeeAccountMasked VARCHAR(40) NULL,
        gatewayRefundId VARCHAR(64) NULL,
        bankReference VARCHAR(40) NULL,
        paidOutOn DATE NULL,
        failureReason VARCHAR(300) NULL,
        approvalRequestId BIGINT UNSIGNED NULL,
        approvedBy BIGINT UNSIGNED NULL,
        approvedAt DATETIME(3) NULL,
        rejectedReason VARCHAR(500) NULL,
        processedAt DATETIME(3) NULL,
        lastCheckedAt DATETIME(3) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        openSlot BIGINT UNSIGNED AS (IF(status IN ('PENDING_APPROVAL','PROCESSING'), paymentId, NULL)) STORED,
        PRIMARY KEY (id),
        UNIQUE KEY uq_refunds_open (openSlot),
        UNIQUE KEY uq_refunds_gateway (gatewayRefundId),
        UNIQUE KEY uq_refunds_no (societyId, refundNo),
        KEY ix_refunds_society_status (societyId, status, createdAt),
        KEY ix_refunds_payment (paymentId),
        KEY ix_refunds_check (status, lastCheckedAt),
        CONSTRAINT fk_refunds_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_refunds_payment FOREIGN KEY (paymentId) REFERENCES payments (id) ON DELETE RESTRICT,
        CONSTRAINT ck_refunds_amount CHECK (amountPaise > 0 AND freedFromAllocationsPaise >= 0),
        CONSTRAINT ck_refunds_mode CHECK (mode IN ('GATEWAY','BANK_TRANSFER','CHEQUE','CASH')),
        CONSTRAINT ck_refunds_status CHECK (status IN ('PENDING_APPROVAL','REJECTED','PROCESSING','PROCESSED','FAILED','CANCELLED')),
        CONSTRAINT ck_refunds_reason CHECK (CHAR_LENGTH(reason) BETWEEN 10 AND 500)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS refunds');
  },
};
