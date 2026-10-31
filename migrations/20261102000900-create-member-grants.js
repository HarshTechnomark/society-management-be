'use strict';
/**
 * Module 03 section 7.5. The foreign key `unitId` to units is added by the module 08 migration.
 * `activeSlot` is VIRTUAL, not STORED: MySQL refuses ON DELETE CASCADE on `permissionId` while it is a base column of a
 * stored generated column. A unique index on a virtual column works the same.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE member_grants (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        memberId BIGINT UNSIGNED NOT NULL,
        permissionId BIGINT UNSIGNED NOT NULL,
        effect VARCHAR(5) NOT NULL DEFAULT 'ALLOW',
        source VARCHAR(10) NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
        startsAt DATETIME(3) NOT NULL,
        endsAt DATETIME(3) NULL,
        reason VARCHAR(300) NULL,
        grantedBy BIGINT UNSIGNED NOT NULL,
        expiryReminderSentAt DATETIME(3) NULL,
        revokedAt DATETIME(3) NULL,
        revokedBy BIGINT UNSIGNED NULL,
        revokeReason VARCHAR(300) NULL,
        unitId BIGINT UNSIGNED NULL,
        activeSlot VARCHAR(64) GENERATED ALWAYS AS (IF(status = 'ACTIVE', CONCAT(memberId, ':', permissionId, ':', IFNULL(unitId, 0)), NULL)) VIRTUAL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_member_grants_active (activeSlot),
        KEY ix_member_grants_member (societyId, memberId, status),
        KEY ix_member_grants_expiry (status, endsAt),
        KEY ix_member_grants_permission (permissionId),
        KEY ix_member_grants_unit (societyId, unitId, status),
        CONSTRAINT fk_member_grants_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_member_grants_member FOREIGN KEY (memberId) REFERENCES society_members (id) ON DELETE RESTRICT,
        CONSTRAINT fk_member_grants_permission FOREIGN KEY (permissionId) REFERENCES permissions (id) ON DELETE CASCADE,
        CONSTRAINT ck_member_grants_effect CHECK (effect IN ('ALLOW','DENY')),
        CONSTRAINT ck_member_grants_source CHECK (source IN ('ADMIN','HOUSEHOLD')),
        CONSTRAINT ck_member_grants_effect_source CHECK (source = 'HOUSEHOLD' OR effect = 'ALLOW'),
        CONSTRAINT ck_member_grants_status CHECK (status IN ('ACTIVE','EXPIRED','REVOKED')),
        CONSTRAINT ck_member_grants_window CHECK (endsAt IS NULL OR endsAt > startsAt),
        CONSTRAINT ck_member_grants_unit CHECK ((source = 'HOUSEHOLD') = (unitId IS NOT NULL))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS member_grants');
  },
};
