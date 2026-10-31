'use strict';
/** Module 02 section 7.5. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE user_recovery_codes (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        userId BIGINT UNSIGNED NOT NULL,
        batchId CHAR(26) NOT NULL,
        codeHash CHAR(64) NOT NULL,
        usedAt DATETIME(3) NULL,
        usedSessionId BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_recovery_user_hash (userId, codeHash),
        KEY ix_recovery_user_used (userId, usedAt),
        CONSTRAINT fk_recovery_user FOREIGN KEY (userId) REFERENCES users (id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS user_recovery_codes');
  },
};
