'use strict';
/** Module 02 section 7.4. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE auth_tokens (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        tokenHash CHAR(64) NOT NULL,
        purpose VARCHAR(24) NOT NULL,
        userId BIGINT UNSIGNED NULL,
        sessionId BIGINT UNSIGNED NULL,
        payload JSON NULL,
        attemptCount TINYINT UNSIGNED NOT NULL DEFAULT 0,
        expiresAt DATETIME(3) NOT NULL,
        consumedAt DATETIME(3) NULL,
        revokedAt DATETIME(3) NULL,
        ip VARCHAR(45) NULL,
        userAgent VARCHAR(255) NULL,
        createdBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_auth_tokens_hash (tokenHash),
        KEY ix_auth_tokens_user_purpose (userId, purpose, consumedAt),
        KEY ix_auth_tokens_expires (expiresAt),
        KEY ix_auth_tokens_session (sessionId),
        CONSTRAINT fk_auth_tokens_user FOREIGN KEY (userId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_auth_tokens_session FOREIGN KEY (sessionId) REFERENCES sessions (id) ON DELETE CASCADE,
        CONSTRAINT ck_auth_tokens_purpose CHECK (purpose IN ('PASSWORD_RESET','ACCOUNT_SETUP','EMAIL_VERIFY','LOGIN_CHALLENGE','WEBAUTHN_CHALLENGE','SIGNUP','SUPPORT_HANDOFF')),
        CONSTRAINT ck_auth_tokens_attempts CHECK (attemptCount BETWEEN 0 AND 5)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS auth_tokens');
  },
};
