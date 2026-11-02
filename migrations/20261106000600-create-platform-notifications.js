'use strict';
/** Module 07 section 7.6: platform announcements to society users (banner plus optional channels). Paranoid. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE platform_notifications (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        title VARCHAR(120) NOT NULL,
        body VARCHAR(2000) NOT NULL,
        kind VARCHAR(15) NOT NULL DEFAULT 'ANNOUNCEMENT',
        severity VARCHAR(10) NOT NULL DEFAULT 'INFO',
        audienceType VARCHAR(20) NOT NULL DEFAULT 'ALL',
        audiencePlanKeys JSON NULL,
        audienceSocietyStatuses JSON NULL,
        audienceSocietyIds JSON NULL,
        audienceRoleKeys JSON NOT NULL,
        channels JSON NOT NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'DRAFT',
        publishAt DATETIME(3) NULL,
        expiresAt DATETIME(3) NOT NULL,
        publishedAt DATETIME(3) NULL,
        cancelledAt DATETIME(3) NULL,
        cancelReason VARCHAR(500) NULL,
        isDismissible TINYINT(1) NOT NULL DEFAULT 1,
        ctaLabel VARCHAR(30) NULL,
        ctaUrl VARCHAR(500) NULL,
        incidentId BIGINT UNSIGNED NULL,
        recipientCount INT UNSIGNED NULL,
        fanoutCompletedAt DATETIME(3) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        deletedAt DATETIME(3) NULL,
        PRIMARY KEY (id),
        KEY ix_pnotif_status_publish (status, publishAt),
        KEY ix_pnotif_status_expires (status, expiresAt),
        KEY ix_pnotif_incident (incidentId),
        CONSTRAINT fk_pnotif_incident FOREIGN KEY (incidentId) REFERENCES incidents (id) ON DELETE RESTRICT,
        CONSTRAINT ck_pnotif_kind CHECK (kind IN ('ANNOUNCEMENT','MAINTENANCE','INCIDENT','RELEASE_NOTE','BILLING')),
        CONSTRAINT ck_pnotif_severity CHECK (severity IN ('INFO','WARNING','CRITICAL')),
        CONSTRAINT ck_pnotif_audience CHECK (audienceType IN ('ALL','PLANS','SOCIETY_STATUSES','SOCIETIES')),
        CONSTRAINT ck_pnotif_status CHECK (status IN ('DRAFT','SCHEDULED','PUBLISHED','EXPIRED','CANCELLED')),
        CONSTRAINT ck_pnotif_cta CHECK ((ctaLabel IS NULL) = (ctaUrl IS NULL)),
        CONSTRAINT ck_pnotif_dismissible CHECK (NOT (severity = 'CRITICAL' AND isDismissible = 1))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS platform_notifications');
  },
};
