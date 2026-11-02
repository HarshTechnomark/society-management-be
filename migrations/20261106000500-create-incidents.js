'use strict';
/** Module 07 section 7.5: incidents with a public timeline (the `updates` JSON is display only). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE incidents (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        title VARCHAR(150) NOT NULL,
        severity VARCHAR(5) NOT NULL,
        status VARCHAR(15) NOT NULL DEFAULT 'INVESTIGATING',
        components JSON NOT NULL,
        serviceProviderId BIGINT UNSIGNED NULL,
        source VARCHAR(16) NOT NULL DEFAULT 'MANUAL',
        isPublic TINYINT(1) NOT NULL DEFAULT 1,
        updates JSON NOT NULL,
        startedAt DATETIME(3) NOT NULL,
        identifiedAt DATETIME(3) NULL,
        monitoringAt DATETIME(3) NULL,
        resolvedAt DATETIME(3) NULL,
        durationMinutes INT UNSIGNED NULL,
        rootCause VARCHAR(2000) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        KEY ix_incidents_status_started (status, startedAt),
        KEY ix_incidents_provider_status (serviceProviderId, status),
        KEY ix_incidents_resolved (resolvedAt),
        CONSTRAINT fk_incidents_provider FOREIGN KEY (serviceProviderId) REFERENCES service_providers (id) ON DELETE RESTRICT,
        CONSTRAINT ck_incidents_severity CHECK (severity IN ('SEV1','SEV2','SEV3','SEV4')),
        CONSTRAINT ck_incidents_status CHECK (status IN ('INVESTIGATING','IDENTIFIED','MONITORING','RESOLVED')),
        CONSTRAINT ck_incidents_source CHECK (source IN ('MANUAL','PROVIDER_AUTO','PROVIDER_MANUAL'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS incidents');
  },
};
