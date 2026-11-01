'use strict';
/** Module 06 section 7.5. One append-only row per reminder, transition or manual dunning action (BR-06-37). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE dunning_events (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        invoiceId BIGINT UNSIGNED NULL,
        step VARCHAR(20) NOT NULL,
        offsetDays SMALLINT NULL,
        scheduledFor DATE NOT NULL,
        dedupeKey VARCHAR(80) NULL,
        outcome VARCHAR(10) NOT NULL,
        skipReason VARCHAR(30) NULL,
        templateKey VARCHAR(60) NULL,
        suspendOnBefore DATE NULL,
        suspendOnAfter DATE NULL,
        notes VARCHAR(500) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_dun_dedupe (dedupeKey),
        KEY ix_dun_society_time (societyId, createdAt),
        KEY ix_dun_invoice (invoiceId, createdAt),
        CONSTRAINT fk_dun_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_dun_invoice FOREIGN KEY (invoiceId) REFERENCES platform_invoices (id) ON DELETE RESTRICT,
        CONSTRAINT ck_dun_step CHECK (step IN ('REMINDER','MANUAL_REMINDER','PAST_DUE','SUSPENDED','GRACE_EXTENDED','CLEARED')),
        CONSTRAINT ck_dun_invoice CHECK (step <> 'CLEARED' OR invoiceId IS NULL),
        CONSTRAINT ck_dun_offset CHECK (offsetDays IS NULL OR (step = 'REMINDER' AND offsetDays BETWEEN -15 AND 14)),
        CONSTRAINT ck_dun_dedupe CHECK (dedupeKey IS NULL OR step NOT IN ('MANUAL_REMINDER','GRACE_EXTENDED')),
        CONSTRAINT ck_dun_outcome CHECK (outcome IN ('DONE','SKIPPED')),
        CONSTRAINT ck_dun_skip_reason CHECK (skipReason IS NULL OR (outcome = 'SKIPPED' AND skipReason IN ('SUPERSEDED','BELOW_MINIMUM','NOT_APPLICABLE','HOLD_ACTIVE','PENDING_MANUAL_PAYMENT','SOCIETY_CLOSED','NOT_OPEN'))),
        CONSTRAINT ck_dun_grace CHECK (step <> 'GRACE_EXTENDED' OR (suspendOnBefore IS NOT NULL AND suspendOnAfter > suspendOnBefore)),
        CONSTRAINT ck_dun_updated_by CHECK (updatedBy IS NULL)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS dunning_events');
  },
};
