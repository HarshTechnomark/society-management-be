'use strict';
/** Module 16 section 7.6: `notification_preferences`. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE notification_preferences (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        userId BIGINT UNSIGNED NOT NULL,
        locale VARCHAR(10) NULL,
        channelMatrix JSON NOT NULL DEFAULT (JSON_OBJECT()),
        quietHoursMode VARCHAR(15) NOT NULL DEFAULT 'SOCIETY_DEFAULT',
        quietHoursStart TIME NULL,
        quietHoursEnd TIME NULL,
        whatsappOptIn TINYINT(1) NOT NULL DEFAULT 0,
        whatsappOptInAt DATETIME(3) NULL,
        whatsappOptInSource VARCHAR(15) NULL,
        whatsappOptOutAt DATETIME(3) NULL,
        emailBouncedAt DATETIME(3) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_prefs_user (userId),
        CONSTRAINT fk_prefs_user FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT ck_prefs_mode CHECK (quietHoursMode IN ('SOCIETY_DEFAULT','CUSTOM','OFF')),
        CONSTRAINT ck_prefs_custom CHECK ((quietHoursMode = 'CUSTOM') = (quietHoursStart IS NOT NULL AND quietHoursEnd IS NOT NULL) AND (quietHoursStart IS NULL OR quietHoursStart <> quietHoursEnd)),
        CONSTRAINT ck_prefs_wa_source CHECK (whatsappOptInSource IS NULL OR whatsappOptInSource IN ('APP','WHATSAPP_REPLY','ONBOARDING'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS notification_preferences');
  },
};
