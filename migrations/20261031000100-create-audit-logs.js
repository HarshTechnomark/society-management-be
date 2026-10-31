'use strict';
/** Module 01 section 7.6: append-only audit table (no updatedAt). Needed by module 02, added on its branch. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE audit_logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NULL,
        actorUserId BIGINT UNSIGNED NULL,
        actorName VARCHAR(120) NOT NULL,
        actorRole VARCHAR(40) NOT NULL,
        supportGrantId BIGINT UNSIGNED NULL,
        action VARCHAR(80) NOT NULL,
        entityType VARCHAR(40) NOT NULL,
        entityId VARCHAR(60) NOT NULL,
        entityLabel VARCHAR(200) NULL,
        \`before\` JSON NULL,
        \`after\` JSON NULL,
        reason VARCHAR(500) NULL,
        ip VARCHAR(45) NULL,
        userAgent VARCHAR(255) NULL,
        requestId VARCHAR(20) NULL,
        createdAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        KEY ix_audit_society_time (societyId, createdAt),
        KEY ix_audit_entity (societyId, entityType, entityId),
        KEY ix_audit_actor (actorUserId, createdAt),
        KEY ix_audit_action (societyId, action, createdAt)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS audit_logs');
  },
};
