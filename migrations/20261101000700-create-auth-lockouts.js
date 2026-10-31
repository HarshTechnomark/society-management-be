'use strict';
/** Module 02 section 7.7. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE auth_lockouts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        scope VARCHAR(10) NOT NULL,
        subjectHash CHAR(64) NOT NULL,
        userId BIGINT UNSIGNED NULL,
        failedCount SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        windowStartedAt DATETIME(3) NOT NULL,
        lastFailedAt DATETIME(3) NOT NULL,
        lockedUntil DATETIME(3) NULL,
        lockCount INT UNSIGNED NOT NULL DEFAULT 0,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_lockouts_scope_subject (scope, subjectHash),
        KEY ix_lockouts_user (userId),
        KEY ix_lockouts_locked (lockedUntil),
        CONSTRAINT fk_lockouts_user FOREIGN KEY (userId) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT ck_lockouts_scope CHECK (scope IN ('OTP','MFA','PASSWORD'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS auth_lockouts');
  },
};
