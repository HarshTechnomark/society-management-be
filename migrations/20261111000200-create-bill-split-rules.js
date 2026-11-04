'use strict';
/**
 * Module 11 section 7 (billing): bill_split_rules. Financial rows have no database FK to `units`, `residents` or `files` (BR-05-21: they
 * are kept after closure while modules 08/09 purge their own rows); those columns are indexed BIGINT snapshots.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE bill_split_rules (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        name VARCHAR(100) NOT NULL,
        description VARCHAR(300) NULL,
        basis VARCHAR(20) NOT NULL,
        amountSource VARCHAR(10) NOT NULL,
        fixedAmountPaise BIGINT NULL,
        scopeType VARCHAR(12) NOT NULL DEFAULT 'ALL_UNITS',
        scopeValues JSON NULL,
        weights JSON NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_split_rules_name (societyId, name),
        KEY ix_split_rules_status (societyId, status),
        CONSTRAINT fk_split_rules_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT ck_split_rules_basis CHECK (basis IN ('EQUAL','AREA','UNIT_TYPE_WEIGHT','CUSTOM_WEIGHT')),
        CONSTRAINT ck_split_rules_source CHECK (amountSource IN ('FIXED','RUN_INPUT')),
        CONSTRAINT ck_split_rules_fixed CHECK ((amountSource = 'FIXED' AND fixedAmountPaise BETWEEN 1 AND 1000000000) OR (amountSource = 'RUN_INPUT' AND fixedAmountPaise IS NULL)),
        CONSTRAINT ck_split_rules_scope CHECK (scopeType IN ('ALL_UNITS','BUILDINGS','UNIT_TYPES','UNITS')),
        CONSTRAINT ck_split_rules_status CHECK (status IN ('ACTIVE','ARCHIVED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS bill_split_rules');
  },
};
