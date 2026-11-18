'use strict';
/** Module 14 section 7.4: approval_delegations (not paranoid: evidence of who could act for whom). Created before the actions that reference it. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE approval_delegations (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        delegatorUserId BIGINT UNSIGNED NOT NULL,
        delegateUserId BIGINT UNSIGNED NOT NULL,
        source VARCHAR(15) NOT NULL,
        types JSON NULL,
        maxAmountPaise BIGINT NULL,
        startsAt DATETIME(3) NOT NULL,
        endsAt DATETIME(3) NOT NULL,
        reason VARCHAR(500) NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
        committeeTermId BIGINT UNSIGNED NULL,
        endingNotifiedAt DATETIME(3) NULL,
        revokedAt DATETIME(3) NULL,
        revokedBy BIGINT UNSIGNED NULL,
        revokeReason VARCHAR(500) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        KEY ix_approval_delegations_delegate (societyId, delegateUserId, status, startsAt, endsAt),
        KEY ix_approval_delegations_delegator (societyId, delegatorUserId, status, startsAt),
        KEY ix_approval_delegations_sweep (status, endsAt),
        CONSTRAINT fk_approval_delegations_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_approval_delegations_delegator FOREIGN KEY (delegatorUserId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_approval_delegations_delegate FOREIGN KEY (delegateUserId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_approval_delegations_revoker FOREIGN KEY (revokedBy) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_approval_delegations_term FOREIGN KEY (committeeTermId) REFERENCES committee_terms (id) ON DELETE RESTRICT,
        CONSTRAINT ck_approval_delegations_self CHECK (delegateUserId <> delegatorUserId),
        CONSTRAINT ck_approval_delegations_source CHECK (source IN ('OUT_OF_OFFICE','TERM_HANDOVER')),
        CONSTRAINT ck_approval_delegations_status CHECK (status IN ('ACTIVE','REVOKED','EXPIRED')),
        CONSTRAINT ck_approval_delegations_window CHECK (endsAt > startsAt)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS approval_delegations');
  },
};
