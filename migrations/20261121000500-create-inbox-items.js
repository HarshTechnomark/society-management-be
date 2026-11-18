'use strict';
/** Module 16 section 7.5: `inbox_items`. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE inbox_items (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        scope VARCHAR(10) NOT NULL,
        societyId BIGINT UNSIGNED NULL,
        userId BIGINT UNSIGNED NOT NULL,
        batchId CHAR(36) NOT NULL,
        templateKey VARCHAR(80) NOT NULL,
        category VARCHAR(12) NOT NULL,
        deliveryClass VARCHAR(15) NOT NULL,
        tone VARCHAR(5) NOT NULL DEFAULT 'info',
        title VARCHAR(150) NOT NULL,
        body VARCHAR(1000) NOT NULL,
        deepLink VARCHAR(300) NULL,
        sourceType VARCHAR(40) NULL,
        sourceId BIGINT UNSIGNED NULL,
        dedupeKey VARCHAR(120) NULL,
        readAt DATETIME(3) NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_inbox_user_dedupe (userId, dedupeKey),
        KEY ix_inbox_user_scope (userId, scope, societyId, id),
        KEY ix_inbox_user_unread (userId, readAt),
        KEY ix_inbox_created (createdAt),
        CONSTRAINT fk_inbox_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_inbox_user FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT ck_inbox_scope CHECK (scope IN ('USER','SOCIETY','PLATFORM')),
        CONSTRAINT ck_inbox_society CHECK ((scope = 'SOCIETY') = (societyId IS NOT NULL)),
        CONSTRAINT ck_inbox_tone CHECK (tone IN ('info','ok','warn','bad'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS inbox_items');
  },
};
