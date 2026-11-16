'use strict';
/**
 * Module 12 section 7.8: collections (festival, event, repair-fund call, donation). Paranoid: only DRAFT and REJECTED rows are
 * soft deleted. `fundId` (module 13 funds) and `approvalRequestId` (module 14) are plain ids until those tables exist.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE collections (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        title VARCHAR(80) NOT NULL,
        kind VARCHAR(15) NOT NULL DEFAULT 'FESTIVAL',
        purpose VARCHAR(1000) NOT NULL,
        amountMode VARCHAR(15) NOT NULL,
        amountPerUnitPaise BIGINT NOT NULL DEFAULT 0,
        minAmountPaise BIGINT NOT NULL DEFAULT 0,
        isMandatory TINYINT(1) NOT NULL DEFAULT 0,
        audienceType VARCHAR(10) NOT NULL DEFAULT 'ALL',
        audienceIds JSON NULL,
        includeVacant TINYINT(1) NOT NULL DEFAULT 0,
        targetPaise BIGINT NOT NULL,
        dueDate DATE NOT NULL,
        fundId BIGINT UNSIGNED NOT NULL,
        payListVisibility VARCHAR(20) NOT NULL DEFAULT 'COUNT_ONLY',
        sendNotice TINYINT(1) NOT NULL DEFAULT 1,
        status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
        requestCount INT UNSIGNED NOT NULL DEFAULT 0,
        paidCount INT UNSIGNED NOT NULL DEFAULT 0,
        contributorCount INT UNSIGNED NOT NULL DEFAULT 0,
        collectedPaise BIGINT NOT NULL DEFAULT 0,
        reminderCount TINYINT UNSIGNED NOT NULL DEFAULT 0,
        lastReminderAt DATETIME(3) NULL,
        approvalRequestId BIGINT UNSIGNED NULL,
        submittedAt DATETIME(3) NULL,
        approvedBy BIGINT UNSIGNED NULL,
        approvedAt DATETIME(3) NULL,
        rejectedReason VARCHAR(500) NULL,
        publishedAt DATETIME(3) NULL,
        publishedBy BIGINT UNSIGNED NULL,
        noticeId BIGINT UNSIGNED NULL,
        closedAt DATETIME(3) NULL,
        closedBy BIGINT UNSIGNED NULL,
        closeReason VARCHAR(300) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        deletedAt DATETIME(3) NULL,
        titleKey VARCHAR(80) AS (IF(deletedAt IS NULL AND status <> 'CANCELLED', LOWER(title), NULL)) STORED,
        PRIMARY KEY (id),
        UNIQUE KEY uq_collections_title (societyId, titleKey),
        KEY ix_collections_status (societyId, status, dueDate),
        KEY ix_collections_fund (fundId),
        CONSTRAINT fk_collections_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT ck_collections_title CHECK (CHAR_LENGTH(title) BETWEEN 4 AND 80),
        CONSTRAINT ck_collections_kind CHECK (kind IN ('FESTIVAL','EVENT','REPAIR_CALL','DONATION','OTHER')),
        CONSTRAINT ck_collections_purpose CHECK (CHAR_LENGTH(purpose) BETWEEN 10 AND 1000),
        CONSTRAINT ck_collections_mode CHECK (amountMode IN ('FIXED_PER_UNIT','MIN_PER_UNIT','VOLUNTARY')),
        CONSTRAINT ck_collections_amount CHECK (amountPerUnitPaise BETWEEN 0 AND 10000000 AND (amountMode = 'VOLUNTARY' OR amountPerUnitPaise >= 100)),
        CONSTRAINT ck_collections_min CHECK ((amountMode = 'MIN_PER_UNIT' AND minAmountPaise BETWEEN 100 AND amountPerUnitPaise) OR (amountMode <> 'MIN_PER_UNIT' AND minAmountPaise = 0)),
        CONSTRAINT ck_collections_mandatory CHECK (isMandatory = 0 OR amountMode = 'FIXED_PER_UNIT'),
        CONSTRAINT ck_collections_audience CHECK ((audienceType = 'ALL' AND audienceIds IS NULL) OR (audienceType IN ('BUILDINGS','UNITS') AND audienceIds IS NOT NULL)),
        CONSTRAINT ck_collections_target CHECK (targetPaise >= 100),
        CONSTRAINT ck_collections_visibility CHECK (payListVisibility IN ('HIDDEN','COUNT_ONLY','FLATS_ONLY','FLATS_AND_AMOUNTS')),
        CONSTRAINT ck_collections_status CHECK (status IN ('DRAFT','PENDING_APPROVAL','CHANGES_REQUESTED','APPROVED','REJECTED','PUBLISHED','CLOSED','CANCELLED')),
        CONSTRAINT ck_collections_collected CHECK (collectedPaise >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS collections');
  },
};
