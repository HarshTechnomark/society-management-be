'use strict';
/**
 * Module 05 section 7.3. `openLockUserId` is a STORED generated column with a unique index, so a platform user holds at
 * most one PENDING_CONSENT or ACTIVE grant (BR-05-26). Its base columns' foreign keys use RESTRICT (MySQL refuses
 * CASCADE or SET NULL on them).
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE support_access_grants (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        platformUserId BIGINT UNSIGNED NOT NULL,
        scope VARCHAR(20) NOT NULL,
        reason VARCHAR(500) NOT NULL,
        ticketRef VARCHAR(30) NULL,
        durationMinutes SMALLINT UNSIGNED NOT NULL DEFAULT 60,
        isEmergency TINYINT(1) NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL,
        consentRequired TINYINT(1) NOT NULL,
        consentStatus VARCHAR(20) NOT NULL,
        consentExpiresAt DATETIME(3) NULL,
        decidedByUserId BIGINT UNSIGNED NULL,
        decidedAt DATETIME(3) NULL,
        decisionNote VARCHAR(300) NULL,
        startedAt DATETIME(3) NULL,
        endsAt DATETIME(3) NULL,
        endedAt DATETIME(3) NULL,
        endedByUserId BIGINT UNSIGNED NULL,
        endReason VARCHAR(30) NULL,
        endNote VARCHAR(300) NULL,
        enteredAt DATETIME(3) NULL,
        requestCount INT UNSIGNED NOT NULL DEFAULT 0,
        writeCount INT UNSIGNED NOT NULL DEFAULT 0,
        lastActivityAt DATETIME(3) NULL,
        openLockUserId BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status IN ('PENDING_CONSENT','ACTIVE') THEN platformUserId ELSE NULL END) STORED,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_sag_open_user (openLockUserId),
        KEY ix_sag_society_status (societyId, status, createdAt),
        KEY ix_sag_status_ends (status, endsAt),
        KEY ix_sag_status_consent (status, consentExpiresAt),
        KEY ix_sag_user_created (platformUserId, createdAt),
        KEY ix_sag_decided_by (decidedByUserId),
        KEY ix_sag_ended_by (endedByUserId),
        CONSTRAINT fk_sag_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_sag_user FOREIGN KEY (platformUserId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_sag_decided_by FOREIGN KEY (decidedByUserId) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT fk_sag_ended_by FOREIGN KEY (endedByUserId) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT ck_sag_scope CHECK (scope IN ('READ_ONLY','READ_WRITE')),
        CONSTRAINT ck_sag_duration CHECK (durationMinutes BETWEEN 15 AND 240 AND durationMinutes % 15 = 0),
        CONSTRAINT ck_sag_emergency CHECK (isEmergency = 0 OR (scope = 'READ_ONLY' AND durationMinutes <= 60)),
        CONSTRAINT ck_sag_status CHECK (status IN ('PENDING_CONSENT','ACTIVE','DENIED','CANCELLED','CONSENT_EXPIRED','EXPIRED','ENDED','REVOKED')),
        CONSTRAINT ck_sag_consent CHECK (consentStatus IN ('NOT_REQUIRED','PENDING','APPROVED','DENIED','EXPIRED','BYPASSED_EMERGENCY','CANCELLED')),
        CONSTRAINT ck_sag_end_reason CHECK (endReason IN ('EXPIRED','ENDED_BY_REQUESTER','REVOKED_BY_SOCIETY','REVOKED_BY_PLATFORM','SOCIETY_CLOSED','USER_DISABLED')),
        CONSTRAINT ck_sag_window CHECK (endsAt IS NULL OR TIMESTAMPDIFF(MINUTE, startedAt, endsAt) = durationMinutes)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS support_access_grants');
  },
};
