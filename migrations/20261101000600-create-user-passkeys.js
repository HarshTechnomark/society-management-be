'use strict';
/** Module 02 section 7.6. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE user_passkeys (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        userId BIGINT UNSIGNED NOT NULL,
        credentialId VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        publicKey VARBINARY(1024) NOT NULL,
        signCount INT UNSIGNED NOT NULL DEFAULT 0,
        transports JSON NULL,
        aaguid CHAR(36) NULL,
        deviceType VARCHAR(14) NOT NULL,
        isBackedUp TINYINT(1) NOT NULL DEFAULT 0,
        name VARCHAR(60) NOT NULL,
        lastUsedAt DATETIME(3) NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_passkeys_credential (credentialId),
        KEY ix_passkeys_user (userId),
        CONSTRAINT fk_passkeys_user FOREIGN KEY (userId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT ck_passkeys_device CHECK (deviceType IN ('SINGLE_DEVICE','MULTI_DEVICE'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS user_passkeys');
  },
};
