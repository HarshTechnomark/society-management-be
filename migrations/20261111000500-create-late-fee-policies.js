'use strict';
/**
 * Module 11 section 7 (billing): late_fee_policies. Financial rows have no database FK to `units`, `residents` or `files` (BR-05-21: they
 * are kept after closure while modules 08/09 purge their own rows); those columns are indexed BIGINT snapshots.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE late_fee_policies (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        policyType VARCHAR(16) NOT NULL,
        interestRatePct DECIMAL(9,4) NULL,
        interestFrom VARCHAR(10) NULL,
        flatFeePaise BIGINT NULL,
        graceDays TINYINT UNSIGNED NOT NULL DEFAULT 0,
        minChargePaise BIGINT NOT NULL DEFAULT 100,
        effectiveFrom DATE NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'PENDING_APPROVAL',
        reason VARCHAR(500) NOT NULL,
        resolutionRef VARCHAR(100) NULL,
        approvalRequestId BIGINT UNSIGNED NULL,
        approvedBy BIGINT UNSIGNED NULL,
        approvedAt DATETIME(3) NULL,
        rejectedReason VARCHAR(500) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        KEY ix_late_fee_effective (societyId, status, effectiveFrom),
        CONSTRAINT fk_late_fee_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT ck_late_fee_type CHECK (policyType IN ('NONE','SIMPLE_INTEREST','FLAT')),
        CONSTRAINT ck_late_fee_interest CHECK (policyType <> 'SIMPLE_INTEREST' OR (interestRatePct BETWEEN 0.0001 AND 21.0000 AND interestFrom IN ('DUE_DATE','GRACE_END') AND flatFeePaise IS NULL)),
        CONSTRAINT ck_late_fee_flat CHECK (policyType <> 'FLAT' OR (flatFeePaise BETWEEN 100 AND 1000000 AND interestRatePct IS NULL AND interestFrom IS NULL)),
        CONSTRAINT ck_late_fee_none CHECK (policyType <> 'NONE' OR (interestRatePct IS NULL AND interestFrom IS NULL AND flatFeePaise IS NULL)),
        CONSTRAINT ck_late_fee_grace CHECK (graceDays <= 30),
        CONSTRAINT ck_late_fee_min CHECK (minChargePaise BETWEEN 0 AND 100000),
        CONSTRAINT ck_late_fee_status CHECK (status IN ('PENDING_APPROVAL','ACTIVE','REJECTED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS late_fee_policies');
  },
};
