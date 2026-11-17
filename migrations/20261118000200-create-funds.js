'use strict';
/** Module 13 section 7.6: funds (sinking, repair, corpus, collection and custom). Each fund owns one FUND ledger account. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE funds (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        fundType VARCHAR(30) NOT NULL,
        name VARCHAR(80) NOT NULL,
        nameKey VARCHAR(80) NOT NULL,
        ledgerAccountId BIGINT UNSIGNED NOT NULL,
        purpose VARCHAR(300) NULL,
        usageRequiresResolution TINYINT(1) NOT NULL DEFAULT 0,
        showToResidents TINYINT(1) NOT NULL DEFAULT 1,
        status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
        closedAt DATETIME(3) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_funds_name (societyId, nameKey),
        UNIQUE KEY uq_funds_ledger (ledgerAccountId),
        KEY ix_funds_status (societyId, status),
        CONSTRAINT fk_funds_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_funds_ledger FOREIGN KEY (ledgerAccountId) REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
        CONSTRAINT ck_funds_type CHECK (fundType IN ('SINKING','REPAIR','CORPUS','COLLECTION','CUSTOM')),
        CONSTRAINT ck_funds_name CHECK (CHAR_LENGTH(name) BETWEEN 2 AND 80),
        CONSTRAINT ck_funds_status CHECK (status IN ('ACTIVE','CLOSED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS funds');
  },
};
