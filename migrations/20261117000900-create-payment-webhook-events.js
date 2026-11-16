'use strict';
/** Module 12 section 7.5: inbox of verified gateway events (payload redacted, at most 64 KB). `gatewayAccountId` is a plain id until module 29. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE payment_webhook_events (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        gatewayAccountId BIGINT UNSIGNED NOT NULL,
        provider VARCHAR(20) NOT NULL,
        providerEventId VARCHAR(120) NOT NULL,
        eventType VARCHAR(60) NOT NULL,
        gatewayOrderId VARCHAR(64) NULL,
        gatewayPaymentId VARCHAR(64) NULL,
        gatewayRefundId VARCHAR(64) NULL,
        gatewayMandateId VARCHAR(64) NULL,
        amountPaise BIGINT NULL,
        payload JSON NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED',
        attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        lastError VARCHAR(500) NULL,
        processedAt DATETIME(3) NULL,
        reviewedBy BIGINT UNSIGNED NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_pwe_event (gatewayAccountId, providerEventId),
        KEY ix_pwe_status (status, createdAt),
        KEY ix_pwe_payment (gatewayPaymentId),
        KEY ix_pwe_society (societyId, createdAt),
        CONSTRAINT fk_pwe_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT ck_pwe_status CHECK (status IN ('RECEIVED','PROCESSED','IGNORED','FAILED_RETRYABLE','NEEDS_REVIEW'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS payment_webhook_events');
  },
};
