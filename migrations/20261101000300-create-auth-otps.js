'use strict';
/** Module 02 section 7.2. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE auth_otps (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        challengeId CHAR(28) NOT NULL,
        userId BIGINT UNSIGNED NULL,
        mobile CHAR(10) NOT NULL,
        purpose VARCHAR(20) NOT NULL,
        channel VARCHAR(10) NOT NULL DEFAULT 'SMS',
        codeHash CHAR(64) NOT NULL,
        isDeliverable TINYINT(1) NOT NULL DEFAULT 1,
        status VARCHAR(12) NOT NULL DEFAULT 'PENDING',
        attemptCount TINYINT UNSIGNED NOT NULL DEFAULT 0,
        resendCount TINYINT UNSIGNED NOT NULL DEFAULT 0,
        sessionId BIGINT UNSIGNED NULL,
        expiresAt DATETIME(3) NOT NULL,
        resendAvailableAt DATETIME(3) NOT NULL,
        verifiedAt DATETIME(3) NULL,
        ip VARCHAR(45) NULL,
        userAgent VARCHAR(255) NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_auth_otps_challenge (challengeId),
        KEY ix_auth_otps_mobile_created (mobile, createdAt),
        KEY ix_auth_otps_status_expires (status, expiresAt),
        KEY ix_auth_otps_user (userId),
        KEY ix_auth_otps_session (sessionId),
        CONSTRAINT fk_auth_otps_user FOREIGN KEY (userId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_auth_otps_session FOREIGN KEY (sessionId) REFERENCES sessions (id) ON DELETE CASCADE,
        CONSTRAINT ck_auth_otps_purpose CHECK (purpose IN ('LOGIN','SIGNUP','REAUTH','CHANGE_MOBILE')),
        CONSTRAINT ck_auth_otps_channel CHECK (channel IN ('SMS','WHATSAPP')),
        CONSTRAINT ck_auth_otps_status CHECK (status IN ('PENDING','VERIFIED','EXPIRED','SUPERSEDED','FAILED')),
        CONSTRAINT ck_auth_otps_attempts CHECK (attemptCount BETWEEN 0 AND 5),
        CONSTRAINT ck_auth_otps_resends CHECK (resendCount BETWEEN 0 AND 3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS auth_otps');
  },
};
