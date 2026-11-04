'use strict';
/**
 * Module 11 section 7 (billing): opening_balances. Financial rows have no database FK to `units`, `residents` or `files` (BR-05-21: they
 * are kept after closure while modules 08/09 purge their own rows); those columns are indexed BIGINT snapshots.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE opening_balances (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        unitId BIGINT UNSIGNED NULL,
        unitLabelInput VARCHAR(30) NOT NULL,
        importFileId BIGINT UNSIGNED NOT NULL,
        importRowNo INT UNSIGNED NOT NULL,
        asOfDate DATE NOT NULL,
        arrearsPrincipalPaise BIGINT NOT NULL DEFAULT 0,
        arrearsInterestPaise BIGINT NOT NULL DEFAULT 0,
        advancePaise BIGINT NOT NULL DEFAULT 0,
        status VARCHAR(10) NOT NULL,
        validationError VARCHAR(300) NULL,
        activeKey VARCHAR(30) NULL,
        invoiceId BIGINT UNSIGNED NULL,
        postedAt DATETIME(3) NULL,
        postedBy BIGINT UNSIGNED NULL,
        reversedAt DATETIME(3) NULL,
        reversedBy BIGINT UNSIGNED NULL,
        reverseReason VARCHAR(500) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_opening_active (societyId, activeKey),
        KEY ix_opening_status (societyId, status),
        KEY ix_opening_unit (societyId, unitId),
        KEY ix_opening_invoice (invoiceId),
        CONSTRAINT fk_opening_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_opening_invoice FOREIGN KEY (invoiceId) REFERENCES invoices (id) ON DELETE RESTRICT,
        CONSTRAINT ck_opening_amounts CHECK (arrearsPrincipalPaise >= 0 AND arrearsInterestPaise >= 0 AND advancePaise >= 0),
        CONSTRAINT ck_opening_either CHECK (NOT (advancePaise > 0 AND arrearsPrincipalPaise + arrearsInterestPaise > 0)),
        CONSTRAINT ck_opening_status CHECK (status IN ('DRAFT','INVALID','POSTED','REVERSED')),
        CONSTRAINT ck_opening_unit CHECK (unitId IS NOT NULL OR status = 'INVALID')
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS opening_balances');
  },
};
