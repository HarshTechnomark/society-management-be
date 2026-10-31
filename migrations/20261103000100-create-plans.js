'use strict';
/** Module 04 section 7.1. The foreign key `currentVersionId` is added in 20261103000300 once `plan_versions` exists. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE plans (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        code VARCHAR(20) NOT NULL,
        name VARCHAR(60) NOT NULL,
        description VARCHAR(300) NULL,
        tierRank TINYINT UNSIGNED NOT NULL,
        isPublic TINYINT(1) NOT NULL DEFAULT 1,
        isActive TINYINT(1) NOT NULL DEFAULT 1,
        currentVersionId BIGINT UNSIGNED NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_plans_code (code),
        UNIQUE KEY uq_plans_rank (tierRank),
        KEY ix_plans_current (currentVersionId),
        CONSTRAINT ck_plans_code CHECK (code IN ('STARTER','STANDARD','PREMIUM','ENTERPRISE')),
        CONSTRAINT ck_plans_rank CHECK (tierRank BETWEEN 1 AND 4),
        CONSTRAINT ck_plans_name CHECK (CHAR_LENGTH(name) BETWEEN 2 AND 60)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS plans');
  },
};
