'use strict';
/** Module 04 section 7.7. `liveTarget` is a STORED generated column; UNIQUE (societyId, liveTarget) allows one live override per target. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE entitlement_overrides (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        targetType VARCHAR(10) NOT NULL,
        entitlementKey VARCHAR(80) NULL,
        moduleNo TINYINT UNSIGNED NULL,
        isEnabled TINYINT(1) NULL,
        limitValue BIGINT UNSIGNED NULL,
        isUnlimited TINYINT(1) NOT NULL DEFAULT 0,
        source VARCHAR(20) NOT NULL,
        reason VARCHAR(500) NOT NULL,
        startsAt DATETIME(3) NOT NULL,
        expiresAt DATETIME(3) NULL,
        revokedAt DATETIME(3) NULL,
        revokedBy BIGINT UNSIGNED NULL,
        revokeReason VARCHAR(500) NULL,
        expiryProcessedAt DATETIME(3) NULL,
        liveTarget VARCHAR(90) GENERATED ALWAYS AS (IF(revokedAt IS NULL, CONCAT(targetType, ':', COALESCE(entitlementKey, moduleNo)), NULL)) STORED,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_overrides_live (societyId, liveTarget),
        KEY ix_overrides_society (societyId, revokedAt),
        KEY ix_overrides_expiry (expiresAt, expiryProcessedAt),
        KEY ix_overrides_trial (societyId, source, entitlementKey),
        CONSTRAINT fk_overrides_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT ck_overrides_target_type CHECK (targetType IN ('KEY','MODULE')),
        CONSTRAINT ck_overrides_source CHECK (source IN ('CONTRACT','SUPPORT','PREMIUM_TRIAL','PROMOTION')),
        CONSTRAINT ck_overrides_window CHECK (expiresAt IS NULL OR expiresAt > startsAt),
        CONSTRAINT ck_overrides_target CHECK (
          (targetType = 'KEY' AND entitlementKey IS NOT NULL AND moduleNo IS NULL)
          OR (targetType = 'MODULE' AND moduleNo IS NOT NULL AND entitlementKey IS NULL AND isEnabled IS NOT NULL))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS entitlement_overrides');
  },
};
