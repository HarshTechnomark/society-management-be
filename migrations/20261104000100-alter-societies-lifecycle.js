'use strict';
/**
 * Module 05 section 7.1 (`05-01-alter-societies-lifecycle`): lifecycle, trial, closure, purge, support consent and health
 * columns on the module 01 `societies` table. Safe to re-run: every column, constraint and index is checked in
 * `information_schema` first. Existing rows are back-filled before the CHECK constraints are added (a TRIAL society
 * gets `trialEndsAt` = createdAt + 14 days, a SUSPENDED one cause MANUAL, a CLOSED one `closedAt` = updatedAt).
 * `down` drops everything in reverse order.
 */
const COLUMNS = [
  ['statusChangedAt', 'DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER status'],
  ['createdVia', "VARCHAR(20) NOT NULL DEFAULT 'ASSISTED'"],
  ['creatorUserId', 'BIGINT UNSIGNED NULL'],
  ['approxFlats', 'SMALLINT UNSIGNED NULL'],
  ['trialEndsAt', 'DATETIME(3) NULL'],
  ['trialExtendedCount', 'TINYINT UNSIGNED NOT NULL DEFAULT 0'],
  ['activatedAt', 'DATETIME(3) NULL'],
  ['pastDueSince', 'DATETIME(3) NULL'],
  ['suspendedAt', 'DATETIME(3) NULL'],
  ['suspensionCause', 'VARCHAR(20) NULL'],
  ['suspensionHoldUntil', 'DATETIME(3) NULL'],
  ['closedAt', 'DATETIME(3) NULL'],
  ['closureReason', 'VARCHAR(30) NULL'],
  ['purgeAfter', 'DATETIME(3) NULL'],
  ['purgeHoldReason', 'VARCHAR(300) NULL'],
  ['purgeHoldSetAt', 'DATETIME(3) NULL'],
  ['purgedAt', 'DATETIME(3) NULL'],
  ['financialPurgedAt', 'DATETIME(3) NULL'],
  ['financialRetainUntil', 'DATE NULL'],
  ['requiresSupportConsent', 'TINYINT(1) NOT NULL DEFAULT 1'],
  ['healthScore', 'TINYINT UNSIGNED NOT NULL DEFAULT 0'],
  ['healthBreakdown', 'JSON NULL'],
  ['healthComputedAt', 'DATETIME(3) NULL'],
  ['activeUsers30', 'INT UNSIGNED NOT NULL DEFAULT 0'],
  ['unitsSnapshot', 'INT UNSIGNED NOT NULL DEFAULT 0'],
  ['lastNudgedAt', 'DATETIME(3) NULL'],
  ['version', 'INT UNSIGNED NOT NULL DEFAULT 1'],
];

const CHECKS = [
  ['ck_societies_created_via', "createdVia IN ('ASSISTED','SELF_SERVE')"],
  ['ck_societies_susp_cause_list', "suspensionCause IN ('NON_PAYMENT','TRIAL_EXPIRED','MANUAL')"],
  [
    'ck_societies_closure_reason',
    "closureReason IN ('CUSTOMER_REQUEST','NON_PAYMENT','TRIAL_NOT_CONVERTED','DUPLICATE','FRAUD','MERGED','OTHER')",
  ],
  ['ck_societies_approx_flats', 'approxFlats BETWEEN 10 AND 20000'],
  ['ck_societies_susp_cause', "(status = 'SUSPENDED') = (suspensionCause IS NOT NULL)"],
  ['ck_societies_closed', "(status = 'CLOSED') = (closedAt IS NOT NULL)"],
  ['ck_societies_trial', "status <> 'TRIAL' OR trialEndsAt IS NOT NULL"],
  ['ck_societies_health', 'healthScore <= 100'],
];

const INDEXES = [
  ['ix_societies_status_trial', '(status, trialEndsAt)'],
  ['ix_societies_status_suspended', '(status, suspendedAt)'],
  ['ix_societies_purge', '(status, purgeAfter, purgedAt)'],
  ['ix_societies_health', '(healthScore)'],
  ['ix_societies_creator', '(creatorUserId, status)'],
  ['ix_societies_pincode', '(pincode)'],
];

async function exists(qi, sql, params) {
  const [rows] = await qi.sequelize.query(sql, { replacements: params });
  return rows.length > 0;
}
const hasColumn = (qi, c) =>
  exists(
    qi,
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'societies' AND COLUMN_NAME = ?",
    [c],
  );
const hasConstraint = (qi, c) =>
  exists(
    qi,
    "SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'societies' AND CONSTRAINT_NAME = ?",
    [c],
  );
const hasIndex = (qi, i) =>
  exists(
    qi,
    "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'societies' AND INDEX_NAME = ?",
    [i],
  );

module.exports = {
  async up(qi) {
    for (const [name, def] of COLUMNS)
      if (!(await hasColumn(qi, name)))
        await qi.sequelize.query(`ALTER TABLE societies ADD COLUMN ${name} ${def}`);

    // back-fill rows created before module 05 so the CHECK constraints hold
    await qi.sequelize.query(
      "UPDATE societies SET trialEndsAt = DATE_ADD(createdAt, INTERVAL 14 DAY) WHERE status = 'TRIAL' AND trialEndsAt IS NULL",
    );
    await qi.sequelize.query(
      "UPDATE societies SET suspensionCause = 'MANUAL', suspendedAt = IFNULL(suspendedAt, updatedAt) WHERE status = 'SUSPENDED' AND suspensionCause IS NULL",
    );
    await qi.sequelize.query(
      "UPDATE societies SET closedAt = updatedAt, closureReason = IFNULL(closureReason, 'OTHER') WHERE status = 'CLOSED' AND closedAt IS NULL",
    );
    await qi.sequelize.query(
      "UPDATE societies SET activatedAt = createdAt WHERE status IN ('ACTIVE','PAST_DUE') AND activatedAt IS NULL",
    );

    for (const [name, expr] of CHECKS)
      if (!(await hasConstraint(qi, name)))
        await qi.sequelize.query(`ALTER TABLE societies ADD CONSTRAINT ${name} CHECK (${expr})`);
    for (const [name, cols] of INDEXES)
      if (!(await hasIndex(qi, name)))
        await qi.sequelize.query(`ALTER TABLE societies ADD INDEX ${name} ${cols}`);
    if (!(await hasConstraint(qi, 'fk_societies_creator')))
      await qi.sequelize.query(
        'ALTER TABLE societies ADD CONSTRAINT fk_societies_creator FOREIGN KEY (creatorUserId) REFERENCES users (id) ON DELETE SET NULL',
      );
  },

  async down(qi) {
    if (await hasConstraint(qi, 'fk_societies_creator'))
      await qi.sequelize.query('ALTER TABLE societies DROP FOREIGN KEY fk_societies_creator');
    for (const [name] of [...INDEXES].reverse())
      if (await hasIndex(qi, name)) await qi.sequelize.query(`ALTER TABLE societies DROP INDEX ${name}`);
    for (const [name] of [...CHECKS].reverse())
      if (await hasConstraint(qi, name)) await qi.sequelize.query(`ALTER TABLE societies DROP CHECK ${name}`);
    for (const [name] of [...COLUMNS].reverse())
      if (await hasColumn(qi, name)) await qi.sequelize.query(`ALTER TABLE societies DROP COLUMN ${name}`);
  },
};
