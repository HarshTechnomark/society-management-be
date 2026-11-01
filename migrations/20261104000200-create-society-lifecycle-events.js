'use strict';
/** Module 05 section 7.2: append-only lifecycle history (no `updatedAt`, no `createdBy`/`updatedBy`). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE society_lifecycle_events (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        eventType VARCHAR(30) NOT NULL,
        fromStatus VARCHAR(20) NULL,
        toStatus VARCHAR(20) NULL,
        triggerSource VARCHAR(20) NOT NULL,
        triggerCode VARCHAR(30) NOT NULL,
        reasonCategory VARCHAR(30) NULL,
        reason VARCHAR(500) NULL,
        actorUserId BIGINT UNSIGNED NULL,
        actorName VARCHAR(120) NOT NULL,
        relatedEntityType VARCHAR(40) NULL,
        relatedEntityId BIGINT UNSIGNED NULL,
        metadata JSON NULL,
        requestId VARCHAR(20) NULL,
        createdAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        KEY ix_sle_society_time (societyId, createdAt),
        KEY ix_sle_trigger (triggerCode, createdAt),
        KEY ix_sle_actor (actorUserId),
        CONSTRAINT fk_sle_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_sle_actor FOREIGN KEY (actorUserId) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT ck_sle_event CHECK (eventType IN ('CREATED','STATUS_CHANGED','TRIAL_EXTENDED','GRACE_GRANTED','AUTO_CLOSE_WARNED','PURGE_HOLD_SET','PURGE_HOLD_CLEARED','PURGE_WARNED','PURGED','FINANCIAL_PURGED')),
        CONSTRAINT ck_sle_from CHECK (fromStatus IN ('TRIAL','ACTIVE','PAST_DUE','SUSPENDED','CLOSED')),
        CONSTRAINT ck_sle_to CHECK (toStatus IN ('TRIAL','ACTIVE','PAST_DUE','SUSPENDED','CLOSED')),
        CONSTRAINT ck_sle_source CHECK (triggerSource IN ('PLATFORM_USER','SOCIETY_USER','PUBLIC_SIGNUP','BILLING','SYSTEM_JOB')),
        CONSTRAINT ck_sle_code CHECK (triggerCode IN ('ASSISTED_CREATE','SELF_SERVE_SIGNUP','MANUAL_CONVERT','FIRST_INVOICE_PAID','TRIAL_EXPIRED','INVOICE_OVERDUE','GRACE_EXPIRED','ACCOUNT_CLEARED','MANUAL_SUSPEND','MANUAL_REACTIVATE','MANUAL_TRIAL_EXTENSION','MANUAL_CLOSE','SUBSCRIPTION_CANCELLED','AUTO_CLOSE','MANUAL_REOPEN','MANUAL_PURGE_HOLD','RETENTION_ELAPSED')),
        CONSTRAINT ck_sle_reason_cat CHECK (reasonCategory IN ('NON_PAYMENT','POLICY_VIOLATION','FRAUD_SUSPECTED','CUSTOMER_REQUEST','LEGAL_DISPUTE','TRIAL_NOT_CONVERTED','DUPLICATE','FRAUD','MERGED','OTHER'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS society_lifecycle_events');
  },
};
