'use strict';
/**
 * Module 01 section 7.2 (core columns). `logoFileId` has no foreign key yet: the `files` table belongs to module 01's
 * files service, which is not built. The owner of `files` adds `fk_societies_logo` in its own migration.
 * Module 05 adds the lifecycle columns.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE societies (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        organizationId BIGINT UNSIGNED NULL,
        name VARCHAR(150) NOT NULL,
        legalName VARCHAR(200) NULL,
        slug VARCHAR(60) NOT NULL,
        registrationNo VARCHAR(60) NULL,
        gstin VARCHAR(15) NULL,
        addressLine1 VARCHAR(200) NOT NULL,
        addressLine2 VARCHAR(200) NULL,
        city VARCHAR(80) NOT NULL,
        state VARCHAR(60) NOT NULL,
        pincode CHAR(6) NOT NULL,
        timezone VARCHAR(40) NOT NULL DEFAULT 'Asia/Kolkata',
        locale VARCHAR(10) NOT NULL DEFAULT 'en-IN',
        fyStartMonth TINYINT UNSIGNED NOT NULL DEFAULT 4,
        status VARCHAR(20) NOT NULL DEFAULT 'TRIAL',
        logoFileId BIGINT UNSIGNED NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_societies_slug (slug),
        KEY ix_societies_status (status),
        KEY ix_societies_org (organizationId),
        CONSTRAINT fk_societies_org FOREIGN KEY (organizationId) REFERENCES organizations (id) ON DELETE RESTRICT,
        CONSTRAINT ck_societies_status CHECK (status IN ('TRIAL','ACTIVE','PAST_DUE','SUSPENDED','CLOSED')),
        CONSTRAINT ck_societies_pincode CHECK (pincode REGEXP '^[1-9][0-9]{5}$'),
        CONSTRAINT ck_societies_fy CHECK (fyStartMonth BETWEEN 1 AND 12),
        CONSTRAINT ck_societies_locale CHECK (locale IN ('en-IN','hi-IN','mr-IN','gu-IN','ta-IN','te-IN','kn-IN','bn-IN'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS societies');
  },
};
