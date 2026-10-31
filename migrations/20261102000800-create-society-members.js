'use strict';
/** Module 03 section 7.4. Not paranoid: ending a membership is a status. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE society_members (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        userId BIGINT UNSIGNED NOT NULL,
        roleId BIGINT UNSIGNED NOT NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
        locationLabel VARCHAR(60) NULL,
        joinedAt DATETIME(3) NOT NULL,
        suspendedAt DATETIME(3) NULL,
        suspendedBy BIGINT UNSIGNED NULL,
        suspendReason VARCHAR(500) NULL,
        endedAt DATETIME(3) NULL,
        endedBy BIGINT UNSIGNED NULL,
        endReason VARCHAR(500) NULL,
        invitationId BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_members_society_user (societyId, userId),
        KEY ix_members_society_status_role (societyId, status, roleId),
        KEY ix_members_user_status (userId, status),
        KEY ix_members_role (roleId),
        CONSTRAINT fk_members_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_members_user FOREIGN KEY (userId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_members_role FOREIGN KEY (roleId) REFERENCES roles (id) ON DELETE RESTRICT,
        CONSTRAINT fk_members_invitation FOREIGN KEY (invitationId) REFERENCES invitations (id) ON DELETE SET NULL,
        CONSTRAINT ck_members_status CHECK (status IN ('ACTIVE','SUSPENDED','ENDED')),
        CONSTRAINT ck_members_suspended CHECK (status <> 'SUSPENDED' OR suspendedAt IS NOT NULL),
        CONSTRAINT ck_members_ended CHECK (status <> 'ENDED' OR endedAt IS NOT NULL)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS society_members');
  },
};
