'use strict';
/** Module 13 section 7.5: append-only history of the society balance (no updatedAt, updatedBy or version). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE balance_history (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        journalEntryId BIGINT UNSIGNED NOT NULL,
        changedAt DATETIME(3) NOT NULL,
        entryDate DATE NOT NULL,
        direction VARCHAR(30) NOT NULL,
        deltaTotalPaise BIGINT NOT NULL DEFAULT 0,
        inBankPaise BIGINT NOT NULL DEFAULT 0,
        clearingPaise BIGINT NOT NULL DEFAULT 0,
        cashPaise BIGINT NOT NULL DEFAULT 0,
        chequesPaise BIGINT NOT NULL DEFAULT 0,
        totalPaise BIGINT NOT NULL DEFAULT 0,
        earmarkedFundsPaise BIGINT NOT NULL DEFAULT 0,
        label VARCHAR(160) NOT NULL,
        refType VARCHAR(40) NOT NULL,
        createdBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_balance_history_entry (journalEntryId),
        KEY ix_balance_history_time (societyId, changedAt),
        KEY ix_balance_history_date (societyId, entryDate, id),
        CONSTRAINT fk_balance_history_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_balance_history_entry FOREIGN KEY (journalEntryId) REFERENCES journal_entries (id) ON DELETE RESTRICT,
        CONSTRAINT ck_balance_history_direction CHECK (direction IN ('IN','OUT','MOVE','FUND_ONLY'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS balance_history');
  },
};
