'use strict';
/** Module 15 section 7.6: assignments (history; at most one current row per ticket). Adds the FK `tickets.currentAssignmentId`. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE ticket_assignments (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        ticketId BIGINT UNSIGNED NOT NULL,
        assigneeType VARCHAR(10) NOT NULL,
        assigneeUserId BIGINT UNSIGNED NULL,
        staffId BIGINT UNSIGNED NULL,
        vendorId BIGINT UNSIGNED NULL,
        workOrderId BIGINT UNSIGNED NULL,
        externalName VARCHAR(120) NULL,
        externalMobile CHAR(10) NULL,
        assigneeLabel VARCHAR(150) NOT NULL,
        method VARCHAR(15) NOT NULL,
        assignedByUserId BIGINT UNSIGNED NULL,
        note VARCHAR(300) NULL,
        assignedAt DATETIME(3) NOT NULL,
        endedAt DATETIME(3) NULL,
        endReason VARCHAR(25) NULL,
        currentKey BIGINT UNSIGNED GENERATED ALWAYS AS (IF(endedAt IS NULL, ticketId, NULL)) STORED,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_ticket_assignments_current (currentKey),
        KEY ix_ticket_assignments_ticket (societyId, ticketId, assignedAt),
        KEY ix_ticket_assignments_user (societyId, assigneeUserId, endedAt),
        KEY ix_ticket_assignments_vendor (societyId, vendorId, endedAt),
        KEY ix_ticket_assignments_staff (societyId, staffId, endedAt),
        KEY ix_ticket_assignments_work_order (workOrderId),
        CONSTRAINT fk_ticket_assignments_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ticket_assignments_ticket FOREIGN KEY (ticketId) REFERENCES tickets (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ticket_assignments_user FOREIGN KEY (assigneeUserId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ticket_assignments_by FOREIGN KEY (assignedByUserId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT ck_ticket_assignments_type CHECK (
          (assigneeType = 'MEMBER' AND assigneeUserId IS NOT NULL AND staffId IS NULL AND vendorId IS NULL AND externalName IS NULL)
          OR (assigneeType = 'STAFF' AND staffId IS NOT NULL AND vendorId IS NULL AND externalName IS NULL)
          OR (assigneeType = 'VENDOR' AND vendorId IS NOT NULL AND assigneeUserId IS NULL AND staffId IS NULL AND externalName IS NULL)
          OR (assigneeType = 'EXTERNAL' AND externalName IS NOT NULL AND externalMobile IS NOT NULL AND assigneeUserId IS NULL AND staffId IS NULL AND vendorId IS NULL)),
        CONSTRAINT ck_ticket_assignments_method CHECK (method IN ('AUTO_CATEGORY','MANUAL','REOPEN')),
        CONSTRAINT ck_ticket_assignments_end CHECK ((endedAt IS NULL) = (endReason IS NULL)),
        CONSTRAINT ck_ticket_assignments_end_reason CHECK (endReason IS NULL OR endReason IN ('REASSIGNED','UNASSIGNED','CANCELLED','MERGED','WORK_ORDER_CANCELLED','ASSIGNEE_INACTIVE'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await qi.sequelize.query(
      `ALTER TABLE tickets ADD CONSTRAINT fk_tickets_current_assignment FOREIGN KEY (currentAssignmentId) REFERENCES ticket_assignments (id) ON DELETE SET NULL`,
    );
  },
  async down(qi) {
    await qi.sequelize.query('ALTER TABLE tickets DROP FOREIGN KEY fk_tickets_current_assignment');
    await qi.sequelize.query('DROP TABLE IF EXISTS ticket_assignments');
  },
};
