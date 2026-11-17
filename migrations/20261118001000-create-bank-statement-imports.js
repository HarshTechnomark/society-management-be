'use strict';
/** Module 13 section 7.10: imported bank statements. `fileId` is a plain id (module 01 files). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE bank_statement_imports (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        bankAccountId BIGINT UNSIGNED NOT NULL,
        fileId BIGINT UNSIGNED NOT NULL,
        fileSha256 CHAR(64) NOT NULL,
        fileFormat VARCHAR(30) NOT NULL,
        parserKey VARCHAR(30) NOT NULL,
        periodFrom DATE NULL,
        periodTo DATE NULL,
        openingBalancePaise BIGINT NULL,
        closingBalancePaise BIGINT NULL,
        lineCount INT UNSIGNED NOT NULL DEFAULT 0,
        duplicateCount INT UNSIGNED NOT NULL DEFAULT 0,
        creditTotalPaise BIGINT NOT NULL DEFAULT 0,
        debitTotalPaise BIGINT NOT NULL DEFAULT 0,
        matchedCount INT UNSIGNED NOT NULL DEFAULT 0,
        status VARCHAR(30) NOT NULL DEFAULT 'UPLOADED',
        errorMessage VARCHAR(500) NULL,
        reconciledBy BIGINT UNSIGNED NULL,
        reconciledAt DATETIME(3) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_statement_imports_file (bankAccountId, fileSha256),
        KEY ix_statement_imports_account (societyId, bankAccountId, createdAt),
        CONSTRAINT fk_statement_imports_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_statement_imports_bank FOREIGN KEY (bankAccountId) REFERENCES bank_accounts (id) ON DELETE RESTRICT,
        CONSTRAINT ck_statement_imports_format CHECK (fileFormat IN ('CSV','XLSX')),
        CONSTRAINT ck_statement_imports_status CHECK (status IN ('UPLOADED','PARSED','FAILED','RECONCILED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS bank_statement_imports');
  },
};
