'use strict';
/** Module 08 section 7.3: one row per saved setting key and society. The registry (schema, default) lives in code. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE society_settings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        settingKey VARCHAR(80) NOT NULL,
        valueJson JSON NOT NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_society_settings_key (societyId, settingKey),
        CONSTRAINT fk_society_settings_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT ck_society_settings_key CHECK (REGEXP_LIKE(settingKey, '^[a-z][a-zA-Z0-9]*\\\\.[a-z][a-zA-Z0-9]*$', 'c'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS society_settings');
  },
};
