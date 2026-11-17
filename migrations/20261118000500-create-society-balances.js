'use strict';
/** Module 13 section 7.4: one row per society with the live balance figures and the books' control state (lock date, closed year, seeding). `unlockApprovalRequestId` is a plain id until module 14 exists. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE society_balances (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        inBankPaise BIGINT NOT NULL DEFAULT 0,
        clearingPaise BIGINT NOT NULL DEFAULT 0,
        cashPaise BIGINT NOT NULL DEFAULT 0,
        chequesPaise BIGINT NOT NULL DEFAULT 0,
        totalPaise BIGINT NOT NULL DEFAULT 0,
        investmentsPaise BIGINT NOT NULL DEFAULT 0,
        earmarkedFundsPaise BIGINT NOT NULL DEFAULT 0,
        lastJournalEntryId BIGINT UNSIGNED NULL,
        lastChangedAt DATETIME(3) NULL,
        booksLockedThrough DATE NULL,
        unlockFromDate DATE NULL,
        unlockUntil DATETIME(3) NULL,
        unlockApprovalRequestId BIGINT UNSIGNED NULL,
        lastClosedFinancialYear CHAR(7) NULL,
        chartSeededAt DATETIME(3) NULL,
        chartTemplateVersion SMALLINT UNSIGNED NOT NULL DEFAULT 1,
        lastVerifiedAt DATETIME(3) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_society_balances_society (societyId),
        CONSTRAINT fk_society_balances_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_society_balances_entry FOREIGN KEY (lastJournalEntryId) REFERENCES journal_entries (id) ON DELETE RESTRICT,
        CONSTRAINT ck_society_balances_total CHECK (totalPaise = inBankPaise + clearingPaise + cashPaise + chequesPaise),
        CONSTRAINT ck_society_balances_unlock CHECK ((unlockFromDate IS NULL) = (unlockUntil IS NULL)),
        CONSTRAINT ck_society_balances_fy CHECK (lastClosedFinancialYear IS NULL OR lastClosedFinancialYear REGEXP '^[0-9]{4}-[0-9]{2}$')
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS society_balances');
  },
};
