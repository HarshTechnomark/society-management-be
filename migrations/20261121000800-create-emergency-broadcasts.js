'use strict';
/** Module 16 section 7.8: `emergency_broadcasts`. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE emergency_broadcasts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        type VARCHAR(20) NOT NULL,
        isDrill TINYINT(1) NOT NULL DEFAULT 0,
        title VARCHAR(120) NOT NULL,
        message VARCHAR(500) NOT NULL,
        audienceType VARCHAR(10) NOT NULL DEFAULT 'ALL',
        audienceBuildingIds JSON NULL,
        includeStaff TINYINT(1) NOT NULL DEFAULT 1,
        collectResponses TINYINT(1) NOT NULL DEFAULT 1,
        status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
        activeKey VARCHAR(30) GENERATED ALWAYS AS (IF(status = 'ACTIVE', CONCAT(type, ':', isDrill), NULL)) STORED,
        sosAlertId BIGINT UNSIGNED NULL,
        startedBy BIGINT UNSIGNED NOT NULL,
        startedAt DATETIME(3) NOT NULL,
        updateCount SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        lastUpdateMessage VARCHAR(500) NULL,
        lastUpdateAt DATETIME(3) NULL,
        realertCount TINYINT UNSIGNED NOT NULL DEFAULT 0,
        lastRealertAt DATETIME(3) NULL,
        lastResolveReminderAt DATETIME(3) NULL,
        resolvedBy BIGINT UNSIGNED NULL,
        resolvedAt DATETIME(3) NULL,
        allClearMessage VARCHAR(500) NULL,
        cancelledBy BIGINT UNSIGNED NULL,
        cancelledAt DATETIME(3) NULL,
        cancelReason VARCHAR(300) NULL,
        recipientCount INT UNSIGNED NOT NULL DEFAULT 0,
        unitCount INT UNSIGNED NOT NULL DEFAULT 0,
        safeCount INT UNSIGNED NOT NULL DEFAULT 0,
        helpCount INT UNSIGNED NOT NULL DEFAULT 0,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_emergency_active (societyId, activeKey),
        KEY ix_emergency_society (societyId, status, startedAt),
        KEY ix_emergency_sos (sosAlertId),
        CONSTRAINT fk_emergency_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_emergency_started_by FOREIGN KEY (startedBy) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_emergency_resolved_by FOREIGN KEY (resolvedBy) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_emergency_cancelled_by FOREIGN KEY (cancelledBy) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT ck_emergency_type CHECK (type IN ('FIRE','GAS_LEAK','WATER','LIFT_STUCK','SECURITY_THREAT','MEDICAL','POWER','NATURAL_DISASTER','OTHER')),
        CONSTRAINT ck_emergency_audience CHECK (audienceType IN ('ALL','BUILDINGS') AND ((audienceType = 'BUILDINGS') = (audienceBuildingIds IS NOT NULL))),
        CONSTRAINT ck_emergency_status CHECK (status IN ('ACTIVE','RESOLVED','CANCELLED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS emergency_broadcasts');
  },
};
