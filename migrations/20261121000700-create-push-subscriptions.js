'use strict';
/** Module 16 section 7.7: `push_subscriptions`. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE push_subscriptions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        userId BIGINT UNSIGNED NOT NULL,
        sessionId BIGINT UNSIGNED NULL,
        app VARCHAR(10) NOT NULL,
        endpoint VARCHAR(1000) NOT NULL,
        endpointHash CHAR(64) NOT NULL,
        p256dh VARCHAR(100) NOT NULL,
        authSecretEnc VARBINARY(128) NOT NULL,
        expirationTime DATETIME(3) NULL,
        userAgent VARCHAR(255) NULL,
        deviceLabel VARCHAR(60) NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
        revokedReason VARCHAR(12) NULL,
        revokedAt DATETIME(3) NULL,
        lastSuccessAt DATETIME(3) NULL,
        lastFailureAt DATETIME(3) NULL,
        consecutiveFailures TINYINT UNSIGNED NOT NULL DEFAULT 0,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_push_endpoint (endpointHash),
        KEY ix_push_user_status (userId, status),
        KEY ix_push_session (sessionId),
        CONSTRAINT fk_push_user FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT fk_push_session FOREIGN KEY (sessionId) REFERENCES sessions (id) ON DELETE SET NULL,
        CONSTRAINT ck_push_app CHECK (app IN ('PLATFORM','ADMIN','RESIDENT','GATE','WORK')),
        CONSTRAINT ck_push_status CHECK (status IN ('ACTIVE','REVOKED')),
        CONSTRAINT ck_push_reason CHECK (revokedReason IS NULL OR revokedReason IN ('USER','LOGOUT','GONE','FAILURES','LIMIT','EXPIRED','USER_DELETED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS push_subscriptions');
  },
};
