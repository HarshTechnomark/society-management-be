'use strict';
/** Module 15 section 7.4: public comments, internal notes and system timeline entries (never edited). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE ticket_comments (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        ticketId BIGINT UNSIGNED NOT NULL,
        kind VARCHAR(20) NOT NULL DEFAULT 'COMMENT',
        visibility VARCHAR(10) NOT NULL DEFAULT 'PUBLIC',
        authorUserId BIGINT UNSIGNED NULL,
        authorRole VARCHAR(10) NOT NULL,
        authorName VARCHAR(120) NOT NULL,
        authorUnitId BIGINT UNSIGNED NULL,
        body VARCHAR(2000) NULL,
        fromStatus VARCHAR(20) NULL,
        toStatus VARCHAR(20) NULL,
        escalationRuleId BIGINT UNSIGNED NULL,
        slaCycle TINYINT UNSIGNED NULL,
        notifyAffected TINYINT(1) NOT NULL DEFAULT 0,
        metadata JSON NULL,
        deletedByUserId BIGINT UNSIGNED NULL,
        deleteReason VARCHAR(300) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        deletedAt DATETIME(3) NULL,
        PRIMARY KEY (id),
        KEY ix_ticket_comments_ticket (societyId, ticketId, createdAt),
        UNIQUE KEY uq_ticket_comments_escalation (ticketId, escalationRuleId, slaCycle),
        KEY ix_ticket_comments_author (authorUserId, createdAt),
        CONSTRAINT fk_ticket_comments_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ticket_comments_ticket FOREIGN KEY (ticketId) REFERENCES tickets (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ticket_comments_author FOREIGN KEY (authorUserId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ticket_comments_unit FOREIGN KEY (authorUnitId) REFERENCES units (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ticket_comments_rule FOREIGN KEY (escalationRuleId) REFERENCES escalation_rules (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ticket_comments_deleted_by FOREIGN KEY (deletedByUserId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT ck_ticket_comments_kind CHECK (kind IN ('COMMENT','STATUS_CHANGE','ASSIGNMENT','PRIORITY_CHANGE','ESCALATION','MERGE','ESTIMATE','RATING','SYSTEM')),
        CONSTRAINT ck_ticket_comments_visibility CHECK (visibility IN ('PUBLIC','INTERNAL')),
        CONSTRAINT ck_ticket_comments_escalation CHECK (kind <> 'ESCALATION' OR visibility = 'INTERNAL'),
        CONSTRAINT ck_ticket_comments_author_role CHECK (authorRole IN ('RESIDENT','ADMIN','STAFF','VENDOR','GUARD','SYSTEM')),
        CONSTRAINT ck_ticket_comments_body CHECK (kind <> 'COMMENT' OR body IS NOT NULL),
        CONSTRAINT ck_ticket_comments_to_status CHECK (kind <> 'STATUS_CHANGE' OR toStatus IS NOT NULL)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS ticket_comments');
  },
};
