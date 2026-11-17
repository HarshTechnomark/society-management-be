'use strict';
/**
 * Module 13 section 7.3: journal lines. Never updated; inserted and deleted only while the parent entry is a DRAFT
 * (`journal.post` inserts the entry as DRAFT, then the lines, then sets POSTED). The retention purge bypasses the delete rule
 * with `@accounts_purge = 1`.
 */
module.exports = {
  async up(qi) {
    const q = s => qi.sequelize.query(s);
    // see 20261118000300: triggers are skipped (model hooks still apply) when MySQL refuses them without SUPER
    const trigger = async s => {
      try {
        await q(s);
      } catch (err) {
        if (!/SUPER privilege|log_bin_trust_function_creators/.test(String(err && err.message))) throw err;
        process.stderr.write(
          'WARN journal_lines trigger skipped: set log_bin_trust_function_creators=1 and re-run it\n',
        );
      }
    };
    await q(`
      CREATE TABLE journal_lines (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        journalEntryId BIGINT UNSIGNED NOT NULL,
        lineNo SMALLINT UNSIGNED NOT NULL,
        ledgerAccountId BIGINT UNSIGNED NOT NULL,
        fundId BIGINT UNSIGNED NULL,
        debitPaise BIGINT NOT NULL DEFAULT 0,
        creditPaise BIGINT NOT NULL DEFAULT 0,
        entryDate DATE NOT NULL,
        lineNarration VARCHAR(200) NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_journal_lines_no (journalEntryId, lineNo),
        KEY ix_journal_lines_account (societyId, ledgerAccountId, entryDate),
        KEY ix_journal_lines_fund (societyId, fundId, entryDate),
        KEY ix_journal_lines_ledger (ledgerAccountId),
        CONSTRAINT fk_journal_lines_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_journal_lines_entry FOREIGN KEY (journalEntryId) REFERENCES journal_entries (id) ON DELETE CASCADE,
        CONSTRAINT fk_journal_lines_ledger FOREIGN KEY (ledgerAccountId) REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
        CONSTRAINT fk_journal_lines_fund FOREIGN KEY (fundId) REFERENCES funds (id) ON DELETE RESTRICT,
        CONSTRAINT ck_journal_lines_amount CHECK (debitPaise >= 0 AND creditPaise >= 0 AND ((debitPaise = 0) <> (creditPaise = 0))),
        CONSTRAINT ck_journal_lines_no CHECK (lineNo BETWEEN 1 AND 200)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await trigger(`
      CREATE TRIGGER trg_journal_lines_no_update BEFORE UPDATE ON journal_lines FOR EACH ROW
      BEGIN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'journal_lines: lines are never updated';
      END`);
    await trigger(`
      CREATE TRIGGER trg_journal_lines_insert BEFORE INSERT ON journal_lines FOR EACH ROW
      BEGIN
        IF COALESCE((SELECT status FROM journal_entries WHERE id = NEW.journalEntryId), 'DRAFT') <> 'DRAFT' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'journal_lines: lines can only be added to a draft entry';
        END IF;
      END`);
    await trigger(`
      CREATE TRIGGER trg_journal_lines_delete BEFORE DELETE ON journal_lines FOR EACH ROW
      BEGIN
        IF COALESCE((SELECT status FROM journal_entries WHERE id = OLD.journalEntryId), 'DRAFT') <> 'DRAFT'
           AND COALESCE(@accounts_purge, 0) <> 1 THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'journal_lines: lines of a posted entry cannot be deleted';
        END IF;
      END`);
  },
  async down(qi) {
    for (const t of ['no_update', 'insert', 'delete'])
      await qi.sequelize.query(`DROP TRIGGER IF EXISTS trg_journal_lines_${t}`);
    await qi.sequelize.query('DROP TABLE IF EXISTS journal_lines');
  },
};
