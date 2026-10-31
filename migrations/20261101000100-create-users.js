'use strict';
/**
 * Module 02 section 7.1. The foreign keys to files (photoFileId) and societies (lastSocietyId) are not created:
 * those tables belong to modules 01 (files) and 05 (societies) and do not exist yet. Their owners add the keys.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE users (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        mobile CHAR(10) NULL,
        mobileVerifiedAt DATETIME(3) NULL,
        email VARCHAR(254) NULL,
        emailVerifiedAt DATETIME(3) NULL,
        name VARCHAR(120) NULL,
        photoFileId BIGINT UNSIGNED NULL,
        locale VARCHAR(10) NOT NULL DEFAULT 'en-IN',
        passwordHash VARCHAR(255) NULL,
        passwordChangedAt DATETIME(3) NULL,
        totpSecretEnc VARCHAR(255) NULL,
        totpLastUsedStep BIGINT UNSIGNED NULL,
        mfaEnabledAt DATETIME(3) NULL,
        platformRoleId BIGINT UNSIGNED NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        statusReason VARCHAR(500) NULL,
        lastLoginAt DATETIME(3) NULL,
        lastSocietyId BIGINT UNSIGNED NULL,
        deletionRequestedAt DATETIME(3) NULL,
        deletionScheduledFor DATETIME(3) NULL,
        anonymisedAt DATETIME(3) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_users_mobile (mobile),
        UNIQUE KEY uq_users_email (email),
        KEY ix_users_status_deletion (status, deletionScheduledFor),
        KEY ix_users_platform_role (platformRoleId),
        KEY ix_users_last_society (lastSocietyId),
        KEY ix_users_photo (photoFileId),
        CONSTRAINT ck_users_locale CHECK (locale IN ('en-IN','hi-IN','mr-IN','gu-IN','ta-IN','te-IN','kn-IN','bn-IN')),
        CONSTRAINT ck_users_status CHECK (status IN ('INVITED','ACTIVE','DISABLED','PENDING_DELETION','DELETED','SYSTEM')),
        CONSTRAINT ck_users_mobile_format CHECK (mobile IS NULL OR mobile REGEXP '^[6-9][0-9]{9}$'),
        CONSTRAINT ck_users_mobile CHECK (mobile IS NOT NULL OR status IN ('DELETED','SYSTEM')),
        CONSTRAINT ck_users_system CHECK (status <> 'SYSTEM' OR (passwordHash IS NULL AND totpSecretEnc IS NULL AND platformRoleId IS NULL)),
        CONSTRAINT ck_users_mfa CHECK (mfaEnabledAt IS NULL OR totpSecretEnc IS NOT NULL),
        CONSTRAINT ck_users_deletion CHECK (status <> 'PENDING_DELETION' OR deletionScheduledFor IS NOT NULL)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS users');
  },
};
