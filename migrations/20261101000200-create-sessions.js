'use strict';
/**
 * Module 02 section 7.3. FKs to societies (activeSocietyId) and support_access_grants (supportGrantId) are added by
 * modules 05; the tables do not exist yet.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE sessions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        userId BIGINT UNSIGNED NOT NULL,
        clientApp VARCHAR(10) NOT NULL,
        activeSocietyId BIGINT UNSIGNED NULL,
        refreshTokenHash CHAR(64) NOT NULL,
        previousTokenHash CHAR(64) NULL,
        rotatedAt DATETIME(3) NULL,
        rotationCount INT UNSIGNED NOT NULL DEFAULT 0,
        amr JSON NOT NULL,
        mfaVerified TINYINT(1) NOT NULL DEFAULT 0,
        authTime DATETIME(3) NOT NULL,
        lastSeenAt DATETIME(3) NOT NULL,
        idleTimeoutMinutes INT UNSIGNED NOT NULL,
        absoluteExpiresAt DATETIME(3) NOT NULL,
        deviceIdHash CHAR(64) NULL,
        deviceLabel VARCHAR(100) NOT NULL DEFAULT 'Unknown device',
        userAgent VARCHAR(255) NULL,
        ipFirst VARCHAR(45) NULL,
        ipLast VARCHAR(45) NULL,
        revokedAt DATETIME(3) NULL,
        revokeReason VARCHAR(24) NULL,
        revokedBy BIGINT UNSIGNED NULL,
        supportGrantId BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_sessions_refresh (refreshTokenHash),
        KEY ix_sessions_user_active (userId, revokedAt, lastSeenAt),
        KEY ix_sessions_user_device (userId, deviceIdHash, createdAt),
        KEY ix_sessions_active_idle (revokedAt, lastSeenAt),
        KEY ix_sessions_society_seen (activeSocietyId, lastSeenAt),
        KEY ix_sessions_seen (lastSeenAt, userId),
        KEY ix_sessions_support_grant (supportGrantId, revokedAt),
        CONSTRAINT fk_sessions_user FOREIGN KEY (userId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT ck_sessions_app CHECK (clientApp IN ('PLATFORM','ADMIN','RESIDENT','GATE','WORK')),
        CONSTRAINT ck_sessions_idle CHECK (idleTimeoutMinutes BETWEEN 5 AND 20160),
        CONSTRAINT ck_sessions_reason CHECK (revokeReason IS NULL OR revokeReason IN ('LOGOUT','USER_REVOKED','ADMIN_REVOKED','TOKEN_REUSE','PASSWORD_CHANGED','PASSWORD_RESET','MFA_RESET','MFA_POLICY_CHANGED','MOBILE_CHANGED','USER_DISABLED','IDLE_TIMEOUT','EXPIRED','DELETION_REQUESTED','ACCOUNT_DELETED','SUPPORT_GRANT_ENDED')),
        CONSTRAINT ck_sessions_revoke CHECK ((revokedAt IS NULL AND revokeReason IS NULL) OR (revokedAt IS NOT NULL AND revokeReason IS NOT NULL)),
        CONSTRAINT ck_sessions_support CHECK (supportGrantId IS NULL OR (clientApp = 'ADMIN' AND activeSocietyId IS NOT NULL))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS sessions');
  },
};
