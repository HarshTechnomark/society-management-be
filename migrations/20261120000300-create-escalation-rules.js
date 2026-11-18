'use strict';
/** Module 15 section 7.7: escalation rules (paranoid: fired timeline entries keep pointing at the row). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE escalation_rules (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        name VARCHAR(80) NOT NULL,
        triggerType VARCHAR(20) NOT NULL,
        thresholdPercent SMALLINT UNSIGNED NULL,
        level TINYINT UNSIGNED NOT NULL,
        categoryId BIGINT UNSIGNED NULL,
        priority VARCHAR(2) NULL,
        targetType VARCHAR(12) NOT NULL,
        targetRoleKey VARCHAR(40) NULL,
        targetDesignation VARCHAR(20) NULL,
        targetUserId BIGINT UNSIGNED NULL,
        notifyAssignee TINYINT(1) NOT NULL DEFAULT 0,
        status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        deletedAt DATETIME(3) NULL,
        PRIMARY KEY (id),
        KEY ix_escalation_rules_match (societyId, status, triggerType, level),
        KEY ix_escalation_rules_category (categoryId),
        CONSTRAINT fk_escalation_rules_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_escalation_rules_category FOREIGN KEY (categoryId) REFERENCES ticket_categories (id) ON DELETE RESTRICT,
        CONSTRAINT fk_escalation_rules_user FOREIGN KEY (targetUserId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT ck_escalation_rules_name CHECK (CHAR_LENGTH(name) BETWEEN 2 AND 80),
        CONSTRAINT ck_escalation_rules_trigger CHECK (triggerType IN ('RESPONSE_SLA','RESOLUTION_SLA','RESIDENT_REQUEST','LOW_CSAT')),
        CONSTRAINT ck_escalation_rules_threshold CHECK (
          (triggerType IN ('RESPONSE_SLA','RESOLUTION_SLA') AND thresholdPercent BETWEEN 25 AND 1000)
          OR (triggerType IN ('RESIDENT_REQUEST','LOW_CSAT') AND thresholdPercent IS NULL)),
        CONSTRAINT ck_escalation_rules_level CHECK (level BETWEEN 1 AND 3),
        CONSTRAINT ck_escalation_rules_priority CHECK (priority IS NULL OR priority IN ('P1','P2','P3','P4')),
        CONSTRAINT ck_escalation_rules_target_type CHECK (targetType IN ('ROLE','DESIGNATION','MEMBER')),
        CONSTRAINT ck_escalation_rules_target CHECK (
          (targetType = 'ROLE' AND targetRoleKey IS NOT NULL AND targetDesignation IS NULL AND targetUserId IS NULL)
          OR (targetType = 'DESIGNATION' AND targetDesignation IS NOT NULL AND targetRoleKey IS NULL AND targetUserId IS NULL)
          OR (targetType = 'MEMBER' AND targetUserId IS NOT NULL AND targetRoleKey IS NULL AND targetDesignation IS NULL)),
        CONSTRAINT ck_escalation_rules_designation CHECK (targetDesignation IS NULL OR targetDesignation IN ('CHAIRMAN','VICE_CHAIRMAN','SECRETARY','JOINT_SECRETARY','TREASURER','MEMBER')),
        CONSTRAINT ck_escalation_rules_status CHECK (status IN ('ACTIVE','INACTIVE'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS escalation_rules');
  },
};
