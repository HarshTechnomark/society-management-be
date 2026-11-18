'use strict';
/** Module 15 section 7.2: SLA policies (one row holds the targets of all four priorities). */
const prio = n => `
        p${n}ResponseMinutes INT UNSIGNED NOT NULL DEFAULT ${[30, 240, 720, 1440][n - 1]},
        p${n}ResolutionMinutes INT UNSIGNED NOT NULL DEFAULT ${[240, 1440, 4320, 10080][n - 1]},
        p${n}Calendar VARCHAR(20) NOT NULL DEFAULT 'TWENTY_FOUR_SEVEN',`;
const checks = [1, 2, 3, 4]
  .map(
    n =>
      `CONSTRAINT ck_sla_p${n}_order CHECK (p${n}ResponseMinutes >= 5 AND p${n}ResponseMinutes < p${n}ResolutionMinutes AND p${n}ResolutionMinutes <= 129600),
        CONSTRAINT ck_sla_p${n}_calendar CHECK (p${n}Calendar IN (${n === 1 ? "'TWENTY_FOUR_SEVEN'" : "'TWENTY_FOUR_SEVEN','BUSINESS_HOURS'"}))`,
  )
  .join(',\n        ');
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE sla_policies (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        name VARCHAR(60) NOT NULL,
        description VARCHAR(300) NULL,
        isDefault TINYINT(1) NOT NULL DEFAULT 0,${[1, 2, 3, 4].map(prio).join('')}
        status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
        archivedAt DATETIME(3) NULL,
        defaultKey TINYINT GENERATED ALWAYS AS (IF(isDefault AND status = 'ACTIVE', 1, NULL)) STORED,
        activeNameKey VARCHAR(60) GENERATED ALWAYS AS (IF(status = 'ACTIVE', name, NULL)) STORED,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_sla_policies_default (societyId, defaultKey),
        UNIQUE KEY uq_sla_policies_name (societyId, activeNameKey),
        CONSTRAINT fk_sla_policies_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT ck_sla_status CHECK (status IN ('ACTIVE','ARCHIVED')),
        CONSTRAINT ck_sla_default_active CHECK (NOT isDefault OR status = 'ACTIVE'),
        ${checks}
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS sla_policies');
  },
};
