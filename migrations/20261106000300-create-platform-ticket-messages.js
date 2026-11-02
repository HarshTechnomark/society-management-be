'use strict';
/** Module 07 section 7.3: immutable ticket thread (public replies, internal notes, system change lines). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE platform_ticket_messages (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        ticketId BIGINT UNSIGNED NOT NULL,
        societyId BIGINT UNSIGNED NOT NULL,
        authorUserId BIGINT UNSIGNED NULL,
        authorSide VARCHAR(10) NOT NULL,
        authorName VARCHAR(120) NOT NULL,
        kind VARCHAR(20) NOT NULL DEFAULT 'MESSAGE',
        visibility VARCHAR(10) NOT NULL DEFAULT 'PUBLIC',
        body TEXT NOT NULL,
        meta JSON NULL,
        attachmentCount TINYINT UNSIGNED NOT NULL DEFAULT 0,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        KEY ix_ptmsg_ticket (ticketId, createdAt),
        KEY ix_ptmsg_society (societyId, createdAt),
        KEY ix_ptmsg_author (authorUserId),
        CONSTRAINT fk_ptmsg_ticket FOREIGN KEY (ticketId) REFERENCES platform_tickets (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ptmsg_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ptmsg_author FOREIGN KEY (authorUserId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT ck_ptmsg_side CHECK (authorSide IN ('SOCIETY','PLATFORM','SYSTEM')),
        CONSTRAINT ck_ptmsg_kind CHECK (kind IN ('MESSAGE','STATUS_CHANGE','ASSIGNMENT','PRIORITY_CHANGE')),
        CONSTRAINT ck_ptmsg_visibility CHECK (visibility IN ('PUBLIC','INTERNAL')),
        CONSTRAINT ck_ptmsg_attachments CHECK (attachmentCount BETWEEN 0 AND 5)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS platform_ticket_messages');
  },
};
