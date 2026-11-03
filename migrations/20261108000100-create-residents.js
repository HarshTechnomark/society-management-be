'use strict';
/**
 * Module 09 section 7.1: a person in the society, with or without a login. Paranoid. `activeMobile` and `activeUserId` are
 * generated so that only non-deleted rows compete for a mobile and a login. `userId` uses RESTRICT, not SET NULL: MySQL does
 * not allow SET NULL on the base column of a stored generated column (users are anonymised, never deleted).
 * No foreign key on `photoFileId`: the module 01 files table does not exist yet.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE residents (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        userId BIGINT UNSIGNED NULL,
        memberId BIGINT UNSIGNED NULL,
        name VARCHAR(120) NOT NULL,
        mobile CHAR(10) NULL,
        alternateMobile CHAR(10) NULL,
        email VARCHAR(254) NULL,
        dateOfBirth DATE NULL,
        gender VARCHAR(12) NULL,
        photoFileId BIGINT UNSIGNED NULL,
        preferredLanguage VARCHAR(10) NOT NULL DEFAULT 'en-IN',
        isNri TINYINT(1) NOT NULL DEFAULT 0,
        overseasPhone VARCHAR(16) NULL,
        localRepresentativeResidentId BIGINT UNSIGNED NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
        source VARCHAR(20) NOT NULL DEFAULT 'ADMIN',
        directoryVisible TINYINT(1) NOT NULL DEFAULT 1,
        showMobileInDirectory TINYINT(1) NOT NULL DEFAULT 0,
        showEmailInDirectory TINYINT(1) NOT NULL DEFAULT 0,
        showPhotoInDirectory TINYINT(1) NOT NULL DEFAULT 0,
        adminNote VARCHAR(500) NULL,
        anonymisedAt DATETIME(3) NULL,
        activeMobile CHAR(10) GENERATED ALWAYS AS (IF(deletedAt IS NULL, mobile, NULL)) STORED,
        activeUserId BIGINT UNSIGNED GENERATED ALWAYS AS (IF(deletedAt IS NULL, userId, NULL)) STORED,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        deletedAt DATETIME(3) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_residents_mobile (societyId, activeMobile),
        UNIQUE KEY uq_residents_user (societyId, activeUserId),
        KEY ix_residents_name (societyId, name),
        KEY ix_residents_status (societyId, status),
        KEY ix_residents_user_all (userId),
        KEY ix_residents_member (memberId),
        KEY ix_residents_localrep (localRepresentativeResidentId),
        CONSTRAINT fk_residents_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_residents_user FOREIGN KEY (userId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_residents_member FOREIGN KEY (memberId) REFERENCES society_members (id) ON DELETE SET NULL,
        CONSTRAINT fk_residents_localrep FOREIGN KEY (localRepresentativeResidentId) REFERENCES residents (id) ON DELETE SET NULL,
        CONSTRAINT ck_residents_mobile CHECK (mobile IS NULL OR REGEXP_LIKE(mobile, '^[6-9][0-9]{9}$', 'c')),
        CONSTRAINT ck_residents_alt_mobile CHECK (alternateMobile IS NULL OR (REGEXP_LIKE(alternateMobile, '^[6-9][0-9]{9}$', 'c') AND (mobile IS NULL OR alternateMobile <> mobile))),
        CONSTRAINT ck_residents_gender CHECK (gender IS NULL OR gender IN ('MALE','FEMALE','OTHER','UNDISCLOSED')),
        CONSTRAINT ck_residents_status CHECK (status IN ('ACTIVE','INACTIVE')),
        CONSTRAINT ck_residents_source CHECK (source IN ('ADMIN','IMPORT','JOIN_REQUEST','HOUSEHOLD','TENANCY','TRANSFER')),
        CONSTRAINT ck_residents_bools CHECK (isNri IN (0,1) AND directoryVisible IN (0,1) AND showMobileInDirectory IN (0,1) AND showEmailInDirectory IN (0,1) AND showPhotoInDirectory IN (0,1))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS residents');
  },
};
