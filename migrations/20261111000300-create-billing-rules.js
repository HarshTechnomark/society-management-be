'use strict';
/**
 * Module 11 section 7 (billing): billing_rules. Financial rows have no database FK to `units`, `residents` or `files` (BR-05-21: they
 * are kept after closure while modules 08/09 purge their own rows); those columns are indexed BIGINT snapshots.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE billing_rules (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        chargeHeadId BIGINT UNSIGNED NOT NULL,
        name VARCHAR(100) NOT NULL,
        scopeType VARCHAR(12) NOT NULL,
        scopeValues JSON NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
        sortOrder SMALLINT UNSIGNED NOT NULL DEFAULT 100,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_billing_rules_name (societyId, chargeHeadId, name),
        KEY ix_billing_rules_head (societyId, chargeHeadId, status),
        CONSTRAINT fk_billing_rules_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_billing_rules_head FOREIGN KEY (chargeHeadId) REFERENCES charge_heads (id) ON DELETE RESTRICT,
        CONSTRAINT ck_billing_rules_scope CHECK (scopeType IN ('ALL_UNITS','BUILDINGS','UNIT_TYPES','UNITS')),
        CONSTRAINT ck_billing_rules_values CHECK ((scopeType = 'ALL_UNITS' AND scopeValues IS NULL) OR (scopeType <> 'ALL_UNITS' AND scopeValues IS NOT NULL AND JSON_TYPE(scopeValues) = 'ARRAY')),
        CONSTRAINT ck_billing_rules_status CHECK (status IN ('ACTIVE','ARCHIVED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS billing_rules');
  },
};
