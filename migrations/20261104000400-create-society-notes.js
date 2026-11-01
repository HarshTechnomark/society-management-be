'use strict';
/** Module 05 section 7.4: platform-internal notes about a society (paranoid). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE society_notes (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        category VARCHAR(20) NOT NULL DEFAULT 'GENERAL',
        body VARCHAR(2000) NOT NULL,
        isPinned TINYINT(1) NOT NULL DEFAULT 0,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NOT NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        deletedAt DATETIME(3) NULL,
        PRIMARY KEY (id),
        KEY ix_sn_society_pinned_time (societyId, isPinned, createdAt),
        KEY ix_sn_author (createdBy),
        CONSTRAINT fk_sn_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_sn_author FOREIGN KEY (createdBy) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT ck_sn_category CHECK (category IN ('GENERAL','BILLING','SUPPORT','ONBOARDING','RISK')),
        CONSTRAINT ck_sn_body CHECK (CHAR_LENGTH(body) BETWEEN 3 AND 2000)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS society_notes');
  },
};
