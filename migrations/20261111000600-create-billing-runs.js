'use strict';
/**
 * Module 11 section 7 (billing): billing_runs. Financial rows have no database FK to `units`, `residents` or `files` (BR-05-21: they
 * are kept after closure while modules 08/09 purge their own rows); those columns are indexed BIGINT snapshots.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE billing_runs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        runLabel VARCHAR(30) NOT NULL,
        runType VARCHAR(15) NOT NULL,
        cycle VARCHAR(12) NOT NULL,
        periodStart DATE NOT NULL,
        periodEnd DATE NOT NULL,
        billDate DATE NOT NULL,
        scopeType VARCHAR(12) NOT NULL DEFAULT 'ALL_UNITS',
        scopeValues JSON NULL,
        splitInputs JSON NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
        activeKey VARCHAR(20) NULL,
        itemCount INT UNSIGNED NOT NULL DEFAULT 0,
        readyCount INT UNSIGNED NOT NULL DEFAULT 0,
        exceptionCount INT UNSIGNED NOT NULL DEFAULT 0,
        excludedCount INT UNSIGNED NOT NULL DEFAULT 0,
        warningCount INT UNSIGNED NOT NULL DEFAULT 0,
        skippedCount INT UNSIGNED NOT NULL DEFAULT 0,
        issuedCount INT UNSIGNED NOT NULL DEFAULT 0,
        subtotalPaise BIGINT NOT NULL DEFAULT 0,
        taxPaise BIGINT NOT NULL DEFAULT 0,
        roundOffPaise BIGINT NOT NULL DEFAULT 0,
        totalPaise BIGINT NOT NULL DEFAULT 0,
        previousRunTotalPaise BIGINT NULL,
        computedAt DATETIME(3) NULL,
        computeError VARCHAR(500) NULL,
        notes VARCHAR(500) NULL,
        approvalRequestId BIGINT UNSIGNED NULL,
        publishedBy BIGINT UNSIGNED NULL,
        publishedAt DATETIME(3) NULL,
        approvedBy BIGINT UNSIGNED NULL,
        approvedAt DATETIME(3) NULL,
        issueStartedAt DATETIME(3) NULL,
        issuedAt DATETIME(3) NULL,
        lastError VARCHAR(500) NULL,
        cancelReason VARCHAR(500) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_billing_runs_active (societyId, activeKey),
        UNIQUE KEY uq_billing_runs_label (societyId, runLabel),
        KEY ix_billing_runs_period (societyId, periodStart, status),
        KEY ix_billing_runs_status (societyId, status, createdAt),
        CONSTRAINT fk_billing_runs_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT ck_billing_runs_type CHECK (runType IN ('REGULAR','SUPPLEMENTARY')),
        CONSTRAINT ck_billing_runs_cycle CHECK (cycle IN ('MONTHLY','QUARTERLY','HALF_YEARLY','ANNUAL')),
        CONSTRAINT ck_billing_runs_period CHECK (periodEnd > periodStart),
        CONSTRAINT ck_billing_runs_scope CHECK (scopeType IN ('ALL_UNITS','BUILDINGS','UNITS')),
        CONSTRAINT ck_billing_runs_regular CHECK (runType <> 'REGULAR' OR scopeType = 'ALL_UNITS'),
        CONSTRAINT ck_billing_runs_status CHECK (status IN ('DRAFT','COMPUTING','PREVIEW','PENDING_APPROVAL','APPROVED','ISSUING','ISSUED','CANCELLED','FAILED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS billing_runs');
  },
};
