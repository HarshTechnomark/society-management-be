'use strict';
/** Module 08 section 7.4: the 8 onboarding steps of a society (rows are created lazily and idempotently). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE onboarding_steps (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        stepKey VARCHAR(12) NOT NULL,
        stepNo TINYINT UNSIGNED NOT NULL,
        isRequired TINYINT(1) NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'PENDING',
        completedAt DATETIME(3) NULL,
        completedBy BIGINT UNSIGNED NULL,
        skipReason VARCHAR(300) NULL,
        lastCheckSummary VARCHAR(200) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_onboarding_steps_key (societyId, stepKey),
        UNIQUE KEY uq_onboarding_steps_no (societyId, stepNo),
        CONSTRAINT fk_onboarding_steps_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT ck_onb_key CHECK (stepKey IN ('PROFILE','STRUCTURE','UNITS','RESIDENTS','BILLING','PAYMENTS','COMMITTEE','GO_LIVE')),
        CONSTRAINT ck_onb_no CHECK (stepNo BETWEEN 1 AND 8),
        CONSTRAINT ck_onb_status CHECK (status IN ('PENDING','DONE','SKIPPED')),
        CONSTRAINT ck_onb_skip CHECK ((status = 'SKIPPED') = (skipReason IS NOT NULL)),
        CONSTRAINT ck_onb_done CHECK ((status = 'PENDING') = (completedAt IS NULL)),
        CONSTRAINT ck_onb_required_skip CHECK (NOT (isRequired = 1 AND status = 'SKIPPED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS onboarding_steps');
  },
};
