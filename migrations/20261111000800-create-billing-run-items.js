'use strict';
/**
 * Module 11 section 7 (billing): billing_run_items. Financial rows have no database FK to `units`, `residents` or `files` (BR-05-21: they
 * are kept after closure while modules 08/09 purge their own rows); those columns are indexed BIGINT snapshots.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE billing_run_items (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        billingRunId BIGINT UNSIGNED NOT NULL,
        unitId BIGINT UNSIGNED NOT NULL,
        unitLabel VARCHAR(30) NOT NULL,
        itemKey VARCHAR(45) NOT NULL,
        billToResidentId BIGINT UNSIGNED NULL,
        billToRelation VARCHAR(10) NULL,
        billToName VARCHAR(150) NULL,
        status VARCHAR(10) NOT NULL,
        exceptionCode VARCHAR(30) NULL,
        exceptionMessage VARCHAR(300) NULL,
        warningCodes VARCHAR(120) NULL,
        linesSnapshot JSON NOT NULL,
        thresholdBasePaise BIGINT NOT NULL DEFAULT 0,
        gstApplied BOOLEAN NOT NULL DEFAULT false,
        subtotalPaise BIGINT NOT NULL DEFAULT 0,
        taxPaise BIGINT NOT NULL DEFAULT 0,
        roundOffPaise BIGINT NOT NULL DEFAULT 0,
        totalPaise BIGINT NOT NULL DEFAULT 0,
        previousTotalPaise BIGINT NULL,
        variancePct DECIMAL(9,4) NULL,
        excludedReason VARCHAR(300) NULL,
        excludedBy BIGINT UNSIGNED NULL,
        invoiceId BIGINT UNSIGNED NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_run_items_key (billingRunId, itemKey),
        KEY ix_run_items_status (societyId, billingRunId, status),
        KEY ix_run_items_unit (societyId, unitId),
        KEY ix_run_items_invoice (invoiceId),
        CONSTRAINT fk_run_items_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_run_items_run FOREIGN KEY (billingRunId) REFERENCES billing_runs (id) ON DELETE CASCADE,
        CONSTRAINT fk_run_items_invoice FOREIGN KEY (invoiceId) REFERENCES invoices (id) ON DELETE RESTRICT,
        CONSTRAINT ck_run_items_relation CHECK (billToRelation IS NULL OR billToRelation IN ('OWNER','CO_OWNER','TENANT')),
        CONSTRAINT ck_run_items_status CHECK (status IN ('READY','EXCEPTION','EXCLUDED','ISSUED')),
        CONSTRAINT ck_run_items_exception CHECK (exceptionCode IS NULL OR exceptionCode IN ('MISSING_AREA','MISSING_UNIT_TYPE_RATE','MISSING_READING','NO_BILL_TO','ALREADY_BILLED')),
        CONSTRAINT ck_run_items_round CHECK (roundOffPaise BETWEEN -49 AND 50)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS billing_run_items');
  },
};
