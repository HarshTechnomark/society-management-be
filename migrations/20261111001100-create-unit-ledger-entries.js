'use strict';
/**
 * Module 11 section 7 (billing): unit_ledger_entries. Financial rows have no database FK to `units`, `residents` or `files` (BR-05-21: they
 * are kept after closure while modules 08/09 purge their own rows); those columns are indexed BIGINT snapshots.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE unit_ledger_entries (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        unitId BIGINT UNSIGNED NOT NULL,
        entryDate DATE NOT NULL,
        entryType VARCHAR(20) NOT NULL,
        refType VARCHAR(30) NOT NULL,
        refId BIGINT UNSIGNED NOT NULL,
        debitPaise BIGINT NOT NULL DEFAULT 0,
        creditPaise BIGINT NOT NULL DEFAULT 0,
        narration VARCHAR(300) NOT NULL,
        createdBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_ledger_ref (societyId, refType, refId, entryType),
        KEY ix_ledger_unit_date (societyId, unitId, entryDate, id),
        CONSTRAINT fk_ledger_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT ck_ledger_type CHECK (entryType IN ('OPENING_BALANCE','INVOICE','DEBIT_NOTE','CREDIT_NOTE','PAYMENT','PAYMENT_REVERSAL','REFUND','ADJUSTMENT')),
        CONSTRAINT ck_ledger_ref CHECK (refType IN ('invoice','billing_note','opening_balance','payment','refund')),
        CONSTRAINT ck_ledger_amounts CHECK (debitPaise >= 0 AND creditPaise >= 0 AND ((debitPaise > 0) <> (creditPaise > 0)))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS unit_ledger_entries');
  },
};
