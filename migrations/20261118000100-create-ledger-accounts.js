'use strict';
/** Module 13 section 7.1: the chart of accounts (one tree per society) with a running balance per account. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE ledger_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        code VARCHAR(12) NOT NULL,
        name VARCHAR(120) NOT NULL,
        accountType VARCHAR(30) NOT NULL,
        subtype VARCHAR(30) NOT NULL DEFAULT 'OTHER',
        parentId BIGINT UNSIGNED NULL,
        systemKey VARCHAR(40) NULL,
        isGroup TINYINT(1) NOT NULL DEFAULT 0,
        isSystem TINYINT(1) NOT NULL DEFAULT 0,
        isActive TINYINT(1) NOT NULL DEFAULT 1,
        isCashBookCategory TINYINT(1) NOT NULL DEFAULT 0,
        transparencyCategory VARCHAR(40) NULL,
        description VARCHAR(300) NULL,
        balancePaise BIGINT NOT NULL DEFAULT 0,
        lastPostedAt DATETIME(3) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_ledger_accounts_code (societyId, code),
        UNIQUE KEY uq_ledger_accounts_key (societyId, systemKey),
        KEY ix_ledger_accounts_parent (societyId, parentId),
        KEY ix_ledger_accounts_subtype (societyId, subtype, isActive),
        CONSTRAINT fk_ledger_accounts_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ledger_accounts_parent FOREIGN KEY (parentId) REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
        CONSTRAINT ck_ledger_accounts_code CHECK (code REGEXP '^[0-9]{4}(-[0-9]{3})?$'),
        CONSTRAINT ck_ledger_accounts_name CHECK (CHAR_LENGTH(name) BETWEEN 2 AND 120),
        CONSTRAINT ck_ledger_accounts_type CHECK (accountType IN ('ASSET','LIABILITY','FUND','INCOME','EXPENSE')),
        CONSTRAINT ck_ledger_accounts_subtype CHECK (subtype IN ('BANK','CASH','PETTY_CASH','CLEARING','CHEQUES','INVESTMENT','RECEIVABLE','PAYABLE','DEPOSIT','TAX','FUND','SURPLUS','OPENING','OTHER'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS ledger_accounts');
  },
};
