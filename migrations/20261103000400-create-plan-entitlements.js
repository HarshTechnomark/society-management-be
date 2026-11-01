'use strict';
/** Module 04 section 7.3. Rows are removed only with a draft version (ON DELETE CASCADE). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE plan_entitlements (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        planVersionId BIGINT UNSIGNED NOT NULL,
        entitlementKey VARCHAR(80) NOT NULL,
        kind VARCHAR(10) NOT NULL,
        isEnabled TINYINT(1) NULL,
        limitValue BIGINT UNSIGNED NULL,
        limitPerFlats INT UNSIGNED NULL,
        overageUnitSize INT UNSIGNED NULL,
        overagePricePaise BIGINT NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_plan_ent_key (planVersionId, entitlementKey),
        CONSTRAINT fk_plan_ent_version FOREIGN KEY (planVersionId) REFERENCES plan_versions (id) ON DELETE CASCADE,
        CONSTRAINT ck_plan_ent_kind CHECK (kind IN ('FEATURE','LIMIT')),
        CONSTRAINT ck_plan_ent_per_flats CHECK (limitPerFlats IS NULL OR limitPerFlats BETWEEN 1 AND 1000),
        CONSTRAINT ck_plan_ent_overage CHECK (overagePricePaise IS NULL OR overagePricePaise >= 0),
        CONSTRAINT ck_plan_ent_shape CHECK (
          (kind = 'FEATURE' AND isEnabled IS NOT NULL AND limitValue IS NULL AND limitPerFlats IS NULL AND overagePricePaise IS NULL)
          OR (kind = 'LIMIT' AND isEnabled IS NULL))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS plan_entitlements');
  },
};
