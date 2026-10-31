'use strict';
/** Module 03 section 7.6. The foreign keys to units (module 08) and residents (module 09) are added by those modules. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE invitations (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NULL,
        roleId BIGINT UNSIGNED NOT NULL,
        name VARCHAR(120) NOT NULL,
        mobile CHAR(10) NOT NULL,
        email VARCHAR(254) NULL,
        locationLabel VARCHAR(60) NULL,
        unitId BIGINT UNSIGNED NULL,
        residentId BIGINT UNSIGNED NULL,
        message VARCHAR(300) NULL,
        tokenHash CHAR(64) NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'PENDING',
        expiresAt DATETIME(3) NOT NULL,
        resendCount TINYINT UNSIGNED NOT NULL DEFAULT 0,
        lastSentAt DATETIME(3) NOT NULL,
        invitedUserId BIGINT UNSIGNED NOT NULL,
        invitedBy BIGINT UNSIGNED NULL,
        acceptedUserId BIGINT UNSIGNED NULL,
        acceptedMemberId BIGINT UNSIGNED NULL,
        respondedAt DATETIME(3) NULL,
        revokedBy BIGINT UNSIGNED NULL,
        revokeReason VARCHAR(500) NULL,
        pendingSlot VARCHAR(40) GENERATED ALWAYS AS (IF(status = 'PENDING', CONCAT(IFNULL(societyId, 0), ':', mobile), NULL)) STORED,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_invitations_token (tokenHash),
        UNIQUE KEY uq_invitations_pending (pendingSlot),
        KEY ix_invitations_society_status (societyId, status, createdAt),
        KEY ix_invitations_expiry (status, expiresAt),
        KEY ix_invitations_mobile (mobile, status),
        KEY ix_invitations_role (roleId),
        KEY ix_invitations_invited_user (invitedUserId, status, expiresAt),
        CONSTRAINT fk_invitations_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_invitations_role FOREIGN KEY (roleId) REFERENCES roles (id) ON DELETE RESTRICT,
        CONSTRAINT fk_invitations_invited_user FOREIGN KEY (invitedUserId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_invitations_accepted_user FOREIGN KEY (acceptedUserId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT ck_invitations_status CHECK (status IN ('PENDING','ACCEPTED','DECLINED','REVOKED','EXPIRED')),
        CONSTRAINT ck_invitations_mobile CHECK (mobile REGEXP '^[6-9][0-9]{9}$'),
        CONSTRAINT ck_invitations_resend CHECK (resendCount <= 3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS invitations');
  },
};
