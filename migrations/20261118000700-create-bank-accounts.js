'use strict';
/**
 * Module 13 section 7.8: bank accounts. The number is stored AES-256-GCM encrypted (`accountNumberEnc`), with last 4 digits and an
 * HMAC hash for uniqueness. `collectionFlagKey` (generated) allows one active collection account per society.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE bank_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        ledgerAccountId BIGINT UNSIGNED NOT NULL,
        displayName VARCHAR(60) NOT NULL,
        bankName VARCHAR(100) NOT NULL,
        branchName VARCHAR(100) NULL,
        ifsc CHAR(11) NOT NULL,
        accountKind VARCHAR(30) NOT NULL DEFAULT 'CURRENT',
        accountHolderName VARCHAR(150) NOT NULL,
        accountNumberEnc VARBINARY(255) NOT NULL,
        accountNumberLast4 CHAR(4) NOT NULL,
        accountNumberHash CHAR(64) NOT NULL,
        isCollectionAccount TINYINT(1) NOT NULL DEFAULT 0,
        statementFormat VARCHAR(30) NOT NULL DEFAULT 'GENERIC_CSV',
        openingBalancePaise BIGINT NOT NULL DEFAULT 0,
        openingBalanceDate DATE NULL,
        verificationStatus VARCHAR(30) NOT NULL DEFAULT 'UNVERIFIED',
        verifiedBy BIGINT UNSIGNED NULL,
        verifiedAt DATETIME(3) NULL,
        lastReconciledDate DATE NULL,
        lastReconciledBalancePaise BIGINT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
        closedAt DATETIME(3) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        collectionFlagKey BIGINT UNSIGNED AS (IF(isCollectionAccount = 1 AND status = 'ACTIVE', societyId, NULL)) STORED,
        PRIMARY KEY (id),
        UNIQUE KEY uq_bank_accounts_ledger (ledgerAccountId),
        UNIQUE KEY uq_bank_accounts_number (societyId, accountNumberHash),
        UNIQUE KEY uq_bank_accounts_collection (collectionFlagKey),
        KEY ix_bank_accounts_status (societyId, status),
        CONSTRAINT fk_bank_accounts_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_bank_accounts_ledger FOREIGN KEY (ledgerAccountId) REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
        CONSTRAINT ck_bank_accounts_ifsc CHECK (ifsc REGEXP '^[A-Z]{4}0[A-Z0-9]{6}$'),
        CONSTRAINT ck_bank_accounts_kind CHECK (accountKind IN ('CURRENT','SAVINGS')),
        CONSTRAINT ck_bank_accounts_format CHECK (statementFormat IN ('GENERIC_CSV','HDFC_CSV','ICICI_CSV','SBI_XLSX','AXIS_CSV','KOTAK_CSV','GENERIC_XLSX')),
        CONSTRAINT ck_bank_accounts_verification CHECK (verificationStatus IN ('UNVERIFIED','VERIFIED')),
        CONSTRAINT ck_bank_accounts_status CHECK (status IN ('ACTIVE','CLOSED')),
        CONSTRAINT ck_bank_accounts_opening CHECK (openingBalancePaise = 0 OR openingBalanceDate IS NOT NULL)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS bank_accounts');
  },
};
