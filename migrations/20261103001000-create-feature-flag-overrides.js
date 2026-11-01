'use strict';
/** Module 04 section 7.9. Removing an override deletes the row; the audit row keeps the before value. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE feature_flag_overrides (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        flagId BIGINT UNSIGNED NOT NULL,
        value TINYINT(1) NOT NULL,
        reason VARCHAR(500) NOT NULL,
        expiresAt DATETIME(3) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_flag_overrides (flagId, societyId),
        KEY ix_flag_overrides_society (societyId),
        CONSTRAINT fk_flag_overrides_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_flag_overrides_flag FOREIGN KEY (flagId) REFERENCES feature_flags (id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS feature_flag_overrides');
  },
};
