'use strict';
/** Module 01 section 7.4: `Idempotency-Key` storage. Added on the module 03 branch because create routes need it. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE idempotency_keys (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        userId BIGINT UNSIGNED NOT NULL,
        idemKey CHAR(36) NOT NULL,
        societyId BIGINT UNSIGNED NULL,
        method VARCHAR(8) NOT NULL,
        path VARCHAR(200) NOT NULL,
        requestHash CHAR(64) NOT NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'IN_PROGRESS',
        responseStatus SMALLINT UNSIGNED NULL,
        responseBody JSON NULL,
        expiresAt DATETIME(3) NOT NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_idem_user_key (userId, idemKey),
        KEY ix_idem_expires (expiresAt),
        CONSTRAINT ck_idem_status CHECK (status IN ('IN_PROGRESS','COMPLETED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS idempotency_keys');
  },
};
