'use strict';
/** Module 15 section 7.5: "Me too" upvotes on building issues (hard delete on removal). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE ticket_upvotes (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        ticketId BIGINT UNSIGNED NOT NULL,
        userId BIGINT UNSIGNED NOT NULL,
        unitId BIGINT UNSIGNED NULL,
        source VARCHAR(10) NOT NULL DEFAULT 'ME_TOO',
        note VARCHAR(300) NULL,
        csatScore TINYINT UNSIGNED NULL,
        csatComment VARCHAR(500) NULL,
        csatAt DATETIME(3) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_ticket_upvotes_user (ticketId, userId),
        KEY ix_ticket_upvotes_user (societyId, userId, createdAt),
        CONSTRAINT fk_ticket_upvotes_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ticket_upvotes_ticket FOREIGN KEY (ticketId) REFERENCES tickets (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ticket_upvotes_user FOREIGN KEY (userId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ticket_upvotes_unit FOREIGN KEY (unitId) REFERENCES units (id) ON DELETE RESTRICT,
        CONSTRAINT ck_ticket_upvotes_source CHECK (source IN ('ME_TOO','MERGE')),
        CONSTRAINT ck_ticket_upvotes_csat CHECK (csatScore IS NULL OR csatScore BETWEEN 1 AND 5)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS ticket_upvotes');
  },
};
