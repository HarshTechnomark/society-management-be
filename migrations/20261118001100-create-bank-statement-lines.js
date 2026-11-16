'use strict';
/** Module 13 section 7.11: lines of an imported statement and their match to a journal line (one to one, BR-13-42). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE bank_statement_lines (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        importId BIGINT UNSIGNED NOT NULL,
        bankAccountId BIGINT UNSIGNED NOT NULL,
        lineNo INT UNSIGNED NOT NULL,
        txnDate DATE NOT NULL,
        valueDate DATE NULL,
        description VARCHAR(300) NOT NULL,
        reference VARCHAR(60) NULL,
        chequeNumber VARCHAR(10) NULL,
        debitPaise BIGINT NOT NULL DEFAULT 0,
        creditPaise BIGINT NOT NULL DEFAULT 0,
        runningBalancePaise BIGINT NULL,
        dedupeHash CHAR(64) NOT NULL,
        matchStatus VARCHAR(30) NOT NULL DEFAULT 'UNMATCHED',
        matchMethod VARCHAR(30) NULL,
        matchConfidence TINYINT UNSIGNED NULL,
        matchedJournalLineId BIGINT UNSIGNED NULL,
        matchedBy BIGINT UNSIGNED NULL,
        matchedAt DATETIME(3) NULL,
        ignoredReason VARCHAR(200) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_statement_lines_dedupe (bankAccountId, dedupeHash),
        UNIQUE KEY uq_statement_lines_match (matchedJournalLineId),
        KEY ix_statement_lines_import (importId, lineNo),
        KEY ix_statement_lines_open (societyId, bankAccountId, matchStatus, txnDate),
        KEY ix_statement_lines_ref (societyId, reference),
        CONSTRAINT fk_statement_lines_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_statement_lines_import FOREIGN KEY (importId) REFERENCES bank_statement_imports (id) ON DELETE RESTRICT,
        CONSTRAINT fk_statement_lines_bank FOREIGN KEY (bankAccountId) REFERENCES bank_accounts (id) ON DELETE RESTRICT,
        CONSTRAINT fk_statement_lines_journal_line FOREIGN KEY (matchedJournalLineId) REFERENCES journal_lines (id) ON DELETE RESTRICT,
        CONSTRAINT ck_statement_lines_amount CHECK ((debitPaise = 0) <> (creditPaise = 0)),
        CONSTRAINT ck_statement_lines_status CHECK (matchStatus IN ('UNMATCHED','MATCHED','IGNORED')),
        CONSTRAINT ck_statement_lines_method CHECK (matchMethod IS NULL OR matchMethod IN ('AUTO_REFERENCE','AUTO_AMOUNT_DATE','MANUAL','CREATED_ENTRY')),
        CONSTRAINT ck_statement_lines_confidence CHECK (matchConfidence IS NULL OR matchConfidence <= 100),
        CONSTRAINT ck_statement_lines_matched CHECK ((matchStatus = 'MATCHED') = (matchedJournalLineId IS NOT NULL))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS bank_statement_lines');
  },
};
