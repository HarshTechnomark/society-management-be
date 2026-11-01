'use strict';
/** Module 04 section 7.2. `publishedPlanId` and `draftPlanId` are STORED generated columns with UNIQUE indexes (BR-04-2). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE plan_versions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        planId BIGINT UNSIGNED NOT NULL,
        versionNo INT UNSIGNED NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
        publishedPlanId BIGINT UNSIGNED GENERATED ALWAYS AS (IF(status = 'PUBLISHED', planId, NULL)) STORED,
        draftPlanId BIGINT UNSIGNED GENERATED ALWAYS AS (IF(status = 'DRAFT', planId, NULL)) STORED,
        pricePerFlatPaise BIGINT NOT NULL DEFAULT 0,
        minBillableFlats INT UNSIGNED NOT NULL,
        annualFreeMonths TINYINT UNSIGNED NOT NULL DEFAULT 2,
        notes VARCHAR(500) NULL,
        publishedAt DATETIME(3) NULL,
        publishedBy BIGINT UNSIGNED NULL,
        retiredAt DATETIME(3) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_plan_versions_no (planId, versionNo),
        UNIQUE KEY uq_plan_versions_published (publishedPlanId),
        UNIQUE KEY uq_plan_versions_draft (draftPlanId),
        KEY ix_plan_versions_status (planId, status),
        CONSTRAINT fk_plan_versions_plan FOREIGN KEY (planId) REFERENCES plans (id) ON DELETE RESTRICT,
        CONSTRAINT ck_plan_versions_status CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
        CONSTRAINT ck_plan_versions_price CHECK (pricePerFlatPaise >= 0),
        CONSTRAINT ck_plan_versions_min CHECK (minBillableFlats BETWEEN 1 AND 100000),
        CONSTRAINT ck_plan_versions_free CHECK (annualFreeMonths BETWEEN 0 AND 6)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS plan_versions');
  },
};
