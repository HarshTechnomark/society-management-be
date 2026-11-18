'use strict';
/** Module 14 section 7.3: approval_actions, the append-only decision log. Two generated columns with unique keys back BR-14-8. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE approval_actions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        requestId BIGINT UNSIGNED NOT NULL,
        round SMALLINT UNSIGNED NOT NULL,
        stepNo TINYINT UNSIGNED NULL,
        action VARCHAR(20) NOT NULL,
        actorUserId BIGINT UNSIGNED NULL,
        onBehalfOfUserId BIGINT UNSIGNED NULL,
        delegationId BIGINT UNSIGNED NULL,
        actorRoleKey VARCHAR(40) NULL,
        actorName VARCHAR(120) NULL,
        slotType VARCHAR(12) NULL,
        slotRef VARCHAR(40) NULL,
        comment VARCHAR(500) NULL,
        authTime DATETIME(3) NULL,
        approvalPrincipal BIGINT UNSIGNED AS (IF(action = 'APPROVED', COALESCE(onBehalfOfUserId, actorUserId), NULL)) STORED,
        approvalActor BIGINT UNSIGNED AS (IF(action = 'APPROVED', actorUserId, NULL)) STORED,
        ip VARCHAR(45) NULL,
        createdAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_approval_actions_principal (requestId, round, approvalPrincipal),
        UNIQUE KEY uq_approval_actions_actor (requestId, round, approvalActor),
        KEY ix_approval_actions_request (requestId, id),
        KEY ix_approval_actions_actor_time (societyId, actorUserId, createdAt),
        CONSTRAINT fk_approval_actions_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_approval_actions_request FOREIGN KEY (requestId) REFERENCES approval_requests (id) ON DELETE RESTRICT,
        CONSTRAINT fk_approval_actions_actor FOREIGN KEY (actorUserId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_approval_actions_behalf FOREIGN KEY (onBehalfOfUserId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_approval_actions_delegation FOREIGN KEY (delegationId) REFERENCES approval_delegations (id) ON DELETE RESTRICT,
        CONSTRAINT ck_approval_actions_action CHECK (action IN ('SUBMITTED','RESUBMITTED','AUTO_APPROVED','APPROVED','REJECTED','CHANGES_REQUESTED','CANCELLED','EXPIRED','REMINDED','ESCALATED','REASSIGNED')),
        CONSTRAINT ck_approval_actions_slot CHECK (slotType IS NULL OR slotType IN ('ROLE','USER','FALLBACK','ESCALATION'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS approval_actions');
  },
};
