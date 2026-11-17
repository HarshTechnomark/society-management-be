'use strict';
/** Module 13 section 7.9: gateway settlements. `items` is a JSON snapshot with a multi-valued index on the gateway payment ids (BR-13-39). `sourceFileId` is a plain id (module 01 files). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE settlements (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        gatewayProvider VARCHAR(30) NOT NULL,
        gatewaySettlementId VARCHAR(60) NOT NULL,
        bankAccountId BIGINT UNSIGNED NULL,
        settlementDate DATE NOT NULL,
        utr VARCHAR(30) NULL,
        grossPaise BIGINT NOT NULL DEFAULT 0,
        refundsPaise BIGINT NOT NULL DEFAULT 0,
        feePaise BIGINT NOT NULL DEFAULT 0,
        feeGstPaise BIGINT NOT NULL DEFAULT 0,
        adjustmentPaise BIGINT NOT NULL DEFAULT 0,
        netPaise BIGINT NOT NULL DEFAULT 0,
        paymentCount INT UNSIGNED NOT NULL DEFAULT 0,
        items JSON NOT NULL,
        unmatchedItems JSON NULL,
        source VARCHAR(30) NOT NULL,
        sourceFileId BIGINT UNSIGNED NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'RECEIVED',
        differenceAcceptedReason VARCHAR(500) NULL,
        journalEntryId BIGINT UNSIGNED NULL,
        postedAt DATETIME(3) NULL,
        lastAttemptAt DATETIME(3) NULL,
        attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_settlements_gateway (societyId, gatewaySettlementId),
        KEY ix_settlements_items ((CAST(items->'$[*].gatewayPaymentId' AS CHAR(64) ARRAY))),
        KEY ix_settlements_status (societyId, status, settlementDate),
        KEY ix_settlements_utr (societyId, utr),
        KEY ix_settlements_bank (bankAccountId),
        KEY ix_settlements_journal (journalEntryId),
        CONSTRAINT fk_settlements_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_settlements_bank FOREIGN KEY (bankAccountId) REFERENCES bank_accounts (id) ON DELETE RESTRICT,
        CONSTRAINT fk_settlements_journal FOREIGN KEY (journalEntryId) REFERENCES journal_entries (id) ON DELETE RESTRICT,
        CONSTRAINT ck_settlements_source CHECK (source IN ('REPORT_UPLOAD','GATEWAY_FETCH')),
        CONSTRAINT ck_settlements_status CHECK (status IN ('RECEIVED','MISMATCH','POSTED')),
        CONSTRAINT ck_settlements_net CHECK (netPaise = grossPaise - refundsPaise - feePaise - feeGstPaise + adjustmentPaise),
        CONSTRAINT ck_settlements_posted CHECK (status <> 'POSTED' OR journalEntryId IS NOT NULL)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS settlements');
  },
};
