'use strict';
/**
 * Module 10 section 7.1: `committee_terms`, the one table of the module. Seats and the hand-over checklist are bounded JSON
 * arrays on the term row. Generated columns `currentSlot`, `draftSlot` and `electionSlot` carry the uniqueness of BR-10-1 and
 * BR-10-19. No foreign key on `electionId` (module 22 adds `fk_ct_election`); the down migration does not touch it.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE committee_terms (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        name VARCHAR(120) NOT NULL,
        kind VARCHAR(12) NOT NULL DEFAULT 'ELECTED',
        source VARCHAR(10) NOT NULL DEFAULT 'MANUAL',
        status VARCHAR(10) NOT NULL DEFAULT 'DRAFT',
        startDate DATE NOT NULL,
        endDate DATE NOT NULL,
        actualEndDate DATE NULL,
        strength TINYINT UNSIGNED NOT NULL,
        electionId BIGINT UNSIGNED NULL,
        resultsDeclaredAt DATETIME(3) NULL,
        predecessorTermId BIGINT UNSIGNED NULL,
        members JSON NOT NULL DEFAULT (JSON_ARRAY()),
        handoverChecklist JSON NOT NULL DEFAULT (JSON_ARRAY()),
        handoverCompletedAt DATETIME(3) NULL,
        tookChargeOn DATE NULL,
        resolutionRef VARCHAR(100) NULL,
        notes VARCHAR(1000) NULL,
        lastReminderDays SMALLINT UNSIGNED NULL,
        lastHandoverReminderDay SMALLINT UNSIGNED NULL,
        activatedAt DATETIME(3) NULL,
        activatedBy BIGINT UNSIGNED NULL,
        expiredAt DATETIME(3) NULL,
        endedAt DATETIME(3) NULL,
        endedBy BIGINT UNSIGNED NULL,
        endReason VARCHAR(500) NULL,
        currentSlot BIGINT UNSIGNED GENERATED ALWAYS AS (IF(status IN ('ACTIVE','EXPIRED') AND deletedAt IS NULL, societyId, NULL)) STORED,
        draftSlot BIGINT UNSIGNED GENERATED ALWAYS AS (IF(status = 'DRAFT' AND deletedAt IS NULL, societyId, NULL)) STORED,
        electionSlot BIGINT UNSIGNED GENERATED ALWAYS AS (IF(deletedAt IS NULL, electionId, NULL)) STORED,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        deletedAt DATETIME(3) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_ct_current (currentSlot),
        UNIQUE KEY uq_ct_draft (draftSlot),
        UNIQUE KEY uq_ct_election (electionSlot),
        KEY ix_ct_society_status (societyId, status, startDate),
        KEY ix_ct_status_end (status, endDate),
        KEY ix_ct_predecessor (predecessorTermId),
        KEY ix_ct_election (electionId),
        CONSTRAINT fk_ct_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ct_predecessor FOREIGN KEY (predecessorTermId) REFERENCES committee_terms (id) ON DELETE RESTRICT,
        CONSTRAINT ck_ct_kind CHECK (kind IN ('ELECTED','PROVISIONAL','AD_HOC')),
        CONSTRAINT ck_ct_source CHECK (source IN ('MANUAL','ELECTION','HISTORICAL')),
        CONSTRAINT ck_ct_status CHECK (status IN ('DRAFT','ACTIVE','EXPIRED','ENDED')),
        CONSTRAINT ck_ct_historical CHECK (source <> 'HISTORICAL' OR status = 'ENDED'),
        CONSTRAINT ck_ct_dates CHECK (endDate > startDate),
        CONSTRAINT ck_ct_strength CHECK (strength BETWEEN 3 AND 25),
        CONSTRAINT ck_ct_election CHECK (source <> 'ELECTION' OR electionId IS NOT NULL),
        CONSTRAINT ck_ct_members CHECK (JSON_TYPE(members) = 'ARRAY' AND JSON_LENGTH(members) <= 150),
        CONSTRAINT ck_ct_checklist CHECK (JSON_TYPE(handoverChecklist) = 'ARRAY' AND JSON_LENGTH(handoverChecklist) <= 40)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS committee_terms');
  },
};
