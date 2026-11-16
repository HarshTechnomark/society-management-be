'use strict';
/** Module 12 section 7.6: AutoPay mandates (UPI AutoPay, e-NACH). `gatewayAccountId` is a plain id until module 29 adds `gateway_accounts`. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE autopay_mandates (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        unitId BIGINT UNSIGNED NOT NULL,
        payerUserId BIGINT UNSIGNED NOT NULL,
        mandateType VARCHAR(12) NOT NULL,
        gatewayAccountId BIGINT UNSIGNED NOT NULL,
        gatewayMandateId VARCHAR(64) NULL,
        gatewayCustomerId VARCHAR(64) NULL,
        payerInstrumentMasked VARCHAR(40) NULL,
        maxAmountPaise BIGINT NOT NULL,
        debitDaysBeforeDue TINYINT UNSIGNED NOT NULL DEFAULT 2,
        startDate DATE NOT NULL,
        endDate DATE NOT NULL,
        status VARCHAR(15) NOT NULL DEFAULT 'PENDING_AUTH',
        consecutiveFailures TINYINT UNSIGNED NOT NULL DEFAULT 0,
        lastDebitAt DATETIME(3) NULL,
        lastDebitStatus VARCHAR(10) NULL,
        activatedAt DATETIME(3) NULL,
        pausedAt DATETIME(3) NULL,
        endedAt DATETIME(3) NULL,
        endReason VARCHAR(30) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        liveSlot VARCHAR(40) AS (IF(status IN ('PENDING_AUTH','ACTIVE','PAUSED'), CONCAT(unitId, ':', payerUserId), NULL)) STORED,
        PRIMARY KEY (id),
        UNIQUE KEY uq_mandate_live (societyId, liveSlot),
        UNIQUE KEY uq_mandate_gateway (gatewayMandateId),
        KEY ix_mandate_status (status, societyId),
        KEY ix_mandate_unit (societyId, unitId),
        KEY ix_mandate_payer (payerUserId),
        CONSTRAINT fk_mandate_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT ck_mandate_type CHECK (mandateType IN ('UPI_AUTOPAY','ENACH')),
        CONSTRAINT ck_mandate_max CHECK ((mandateType = 'UPI_AUTOPAY' AND maxAmountPaise BETWEEN 100 AND 1500000) OR (mandateType = 'ENACH' AND maxAmountPaise BETWEEN 100 AND 100000000)),
        CONSTRAINT ck_mandate_days CHECK (debitDaysBeforeDue BETWEEN 1 AND 5),
        CONSTRAINT ck_mandate_dates CHECK (endDate > startDate AND endDate <= DATE_ADD(startDate, INTERVAL 10 YEAR)),
        CONSTRAINT ck_mandate_status CHECK (status IN ('PENDING_AUTH','ACTIVE','PAUSED','CANCELLED','EXPIRED','FAILED')),
        CONSTRAINT ck_mandate_debit_status CHECK (lastDebitStatus IS NULL OR lastDebitStatus IN ('SUCCESS','FAILED','SKIPPED')),
        CONSTRAINT ck_mandate_end_reason CHECK (endReason IS NULL OR endReason IN ('PAYER_CANCELLED','ADMIN_CANCELLED','UNIT_LINK_ENDED','SOCIETY_CLOSED','GATEWAY_CANCELLED','AUTH_FAILED','AUTH_TIMEOUT','END_DATE'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS autopay_mandates');
  },
};
