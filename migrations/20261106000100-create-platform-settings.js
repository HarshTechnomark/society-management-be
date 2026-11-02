'use strict';
/** Module 07 section 7.1: one row per platform setting key. The schema of every key lives in code (settings registry). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE platform_settings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        settingKey VARCHAR(80) NOT NULL,
        category VARCHAR(20) NOT NULL,
        valueType VARCHAR(10) NOT NULL,
        valueJson JSON NOT NULL,
        isReadOnly TINYINT(1) NOT NULL DEFAULT 0,
        description VARCHAR(300) NOT NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_platform_settings_key (settingKey),
        KEY ix_platform_settings_category (category),
        CONSTRAINT ck_ps_category CHECK (category IN ('GENERAL','BILLING','LIFECYCLE','SECURITY','NOTIFICATIONS','SUPPORT','DATA','STATUS')),
        CONSTRAINT ck_ps_type CHECK (valueType IN ('STRING','INTEGER','BOOLEAN','JSON')),
        CONSTRAINT ck_ps_key CHECK (settingKey REGEXP '^[a-z][a-zA-Z0-9]*(\\\\.[a-z][a-zA-Z0-9]*)+$')
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS platform_settings');
  },
};
