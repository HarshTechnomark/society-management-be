'use strict';
/** Module 04 section 7.8. Archived flags keep their row (paranoid `deletedAt`) so the key stays reserved. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE feature_flags (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        flagKey VARCHAR(80) NOT NULL,
        description VARCHAR(300) NOT NULL,
        type VARCHAR(20) NOT NULL,
        isEnabled TINYINT(1) NOT NULL DEFAULT 0,
        minPlanCode VARCHAR(20) NULL,
        rolloutPercent TINYINT UNSIGNED NOT NULL DEFAULT 0,
        isClientVisible TINYINT(1) NOT NULL DEFAULT 0,
        ownerTeam VARCHAR(60) NULL,
        expiresOn DATE NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        deletedAt DATETIME(3) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_feature_flags_key (flagKey),
        KEY ix_feature_flags_type (type),
        CONSTRAINT ck_feature_flags_type CHECK (type IN ('GLOBAL','PLAN','TENANT','PERCENTAGE','KILL_SWITCH')),
        CONSTRAINT ck_feature_flags_plan CHECK (minPlanCode IS NULL OR minPlanCode IN ('STARTER','STANDARD','PREMIUM','ENTERPRISE')),
        CONSTRAINT ck_feature_flags_rollout CHECK (rolloutPercent BETWEEN 0 AND 100)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS feature_flags');
  },
};
