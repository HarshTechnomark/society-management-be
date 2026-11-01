'use strict';
/**
 * Module 05 section 7.5. `runningLockSocietyId` (STORED, unique) allows one QUEUED or RUNNING export per society
 * (BR-05-22). `fileIds` has no foreign key: the module 01 `files` table is not built yet.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE data_exports (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        kind VARCHAR(20) NOT NULL,
        requestedVia VARCHAR(20) NOT NULL,
        requestedByUserId BIGINT UNSIGNED NULL,
        reason VARCHAR(300) NULL,
        includeDocuments TINYINT(1) NOT NULL DEFAULT 1,
        status VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
        progressPercent TINYINT UNSIGNED NOT NULL DEFAULT 0,
        fileIds JSON NULL,
        partCount TINYINT UNSIGNED NOT NULL DEFAULT 0,
        totalSizeBytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        manifestSummary JSON NULL,
        attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
        errorCode VARCHAR(40) NULL,
        startedAt DATETIME(3) NULL,
        completedAt DATETIME(3) NULL,
        expiresAt DATETIME(3) NULL,
        downloadCount INT UNSIGNED NOT NULL DEFAULT 0,
        lastDownloadedAt DATETIME(3) NULL,
        runningLockSocietyId BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status IN ('QUEUED','RUNNING') THEN societyId ELSE NULL END) STORED,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_de_running (runningLockSocietyId),
        KEY ix_de_society_time (societyId, createdAt),
        KEY ix_de_status_expires (status, expiresAt),
        KEY ix_de_society_kind_created (societyId, kind, createdAt),
        KEY ix_de_requested_by (requestedByUserId),
        CONSTRAINT fk_de_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_de_requested_by FOREIGN KEY (requestedByUserId) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT ck_de_kind CHECK (kind IN ('FULL','CLOSURE')),
        CONSTRAINT ck_de_via CHECK (requestedVia IN ('SOCIETY','PLATFORM','SYSTEM')),
        CONSTRAINT ck_de_status CHECK (status IN ('QUEUED','RUNNING','READY','FAILED','EXPIRED')),
        CONSTRAINT ck_de_progress CHECK (progressPercent <= 100),
        CONSTRAINT ck_de_parts CHECK (partCount <= 200)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS data_exports');
  },
};
