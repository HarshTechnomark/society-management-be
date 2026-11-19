'use strict';
/** Module 16 section 7.10: `surveys`. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE surveys (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        title VARCHAR(150) NOT NULL,
        description VARCHAR(2000) NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'DRAFT',
        isAnonymous TINYINT(1) NOT NULL DEFAULT 0,
        responseScope VARCHAR(10) NOT NULL DEFAULT 'PERSON',
        resultsVisibility VARCHAR(25) NOT NULL DEFAULT 'ADMINS',
        audienceType VARCHAR(10) NOT NULL DEFAULT 'ALL',
        audienceRelation VARCHAR(10) NOT NULL DEFAULT 'ANY',
        audienceIds JSON NULL,
        openedAt DATETIME(3) NULL,
        closesAt DATETIME(3) NULL,
        closedAt DATETIME(3) NULL,
        cancelledAt DATETIME(3) NULL,
        cancelReason VARCHAR(300) NULL,
        reminderSentAt DATETIME(3) NULL,
        recipientCount INT UNSIGNED NOT NULL DEFAULT 0,
        responseCount INT UNSIGNED NOT NULL DEFAULT 0,
        questionCount TINYINT UNSIGNED NOT NULL DEFAULT 0,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        deletedAt DATETIME(3) NULL,
        PRIMARY KEY (id),
        KEY ix_surveys_society_status (societyId, status, closesAt),
        KEY ix_surveys_close (status, closesAt),
        CONSTRAINT fk_surveys_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT ck_surveys_status CHECK (status IN ('DRAFT','OPEN','CLOSED','CANCELLED')),
        CONSTRAINT ck_surveys_scope CHECK (responseScope IN ('PERSON','FLAT')),
        CONSTRAINT ck_surveys_visibility CHECK (resultsVisibility IN ('ADMINS','RESPONDENTS_AFTER_CLOSE','ALL_AFTER_CLOSE')),
        CONSTRAINT ck_surveys_audience_type CHECK (audienceType IN ('ALL','BUILDINGS','UNITS')),
        CONSTRAINT ck_surveys_audience_relation CHECK (audienceRelation IN ('ANY','OWNERS','TENANTS')),
        CONSTRAINT ck_surveys_audience_ids CHECK ((audienceType IN ('BUILDINGS','UNITS')) = (audienceIds IS NOT NULL))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS surveys');
  },
};
