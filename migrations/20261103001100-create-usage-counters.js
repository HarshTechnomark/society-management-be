'use strict';
/** Module 04 section 7.10. Rows change only through atomic SQL updates and the close job. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE usage_counters (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        limitKey VARCHAR(80) NOT NULL,
        periodKey VARCHAR(10) NOT NULL,
        used BIGINT UNSIGNED NOT NULL DEFAULT 0,
        lastWarnedPct TINYINT UNSIGNED NOT NULL DEFAULT 0,
        closedAt DATETIME(3) NULL,
        limitAtClose BIGINT UNSIGNED NULL,
        overageUnits BIGINT UNSIGNED NOT NULL DEFAULT 0,
        cycleAtClose VARCHAR(10) NULL,
        overageInvoiceId BIGINT UNSIGNED NULL,
        lastReconciledAt DATETIME(3) NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_usage (societyId, limitKey, periodKey),
        KEY ix_usage_period (periodKey, limitKey),
        KEY ix_usage_open (closedAt, periodKey),
        CONSTRAINT fk_usage_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT ck_usage_period CHECK (periodKey = 'ALL' OR periodKey REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
        CONSTRAINT ck_usage_warned CHECK (lastWarnedPct IN (0, 80, 100)),
        CONSTRAINT ck_usage_cycle CHECK (cycleAtClose IS NULL OR cycleAtClose IN ('MONTHLY','ANNUAL'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS usage_counters');
  },
};
