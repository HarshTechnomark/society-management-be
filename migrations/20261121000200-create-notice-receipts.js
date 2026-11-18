'use strict';
/** Module 16 section 7.2: `notice_receipts`. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE notice_receipts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        noticeId BIGINT UNSIGNED NOT NULL,
        recipientKey VARCHAR(40) NOT NULL,
        userId BIGINT UNSIGNED NULL,
        residentId BIGINT UNSIGNED NULL,
        unitId BIGINT UNSIGNED NULL,
        relation VARCHAR(12) NULL,
        reachedAt DATETIME(3) NULL,
        reachedVia VARCHAR(10) NULL,
        firstReadAt DATETIME(3) NULL,
        readCount SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        acknowledgedAt DATETIME(3) NULL,
        ackRevisionNo SMALLINT UNSIGNED NULL,
        ackIp VARCHAR(45) NULL,
        ackUserAgent VARCHAR(255) NULL,
        remindersSent TINYINT UNSIGNED NOT NULL DEFAULT 0,
        lastRemindedAt DATETIME(3) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_receipts_notice_key (noticeId, recipientKey),
        KEY ix_receipts_user (societyId, userId, noticeId),
        KEY ix_receipts_notice_unit (noticeId, unitId),
        KEY ix_receipts_notice_ack (noticeId, acknowledgedAt),
        CONSTRAINT fk_receipts_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_receipts_notice FOREIGN KEY (noticeId) REFERENCES notices (id) ON DELETE CASCADE,
        CONSTRAINT fk_receipts_user FOREIGN KEY (userId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_receipts_unit FOREIGN KEY (unitId) REFERENCES units (id) ON DELETE RESTRICT,
        CONSTRAINT ck_receipts_relation CHECK (relation IS NULL OR relation IN ('OWNER','CO_OWNER','TENANT','FAMILY','CARETAKER','MEMBER')),
        CONSTRAINT ck_receipts_via CHECK (reachedVia IS NULL OR reachedVia IN ('IN_APP','PUSH','SMS','WHATSAPP','EMAIL')),
        CONSTRAINT ck_receipts_who CHECK (userId IS NOT NULL OR residentId IS NOT NULL)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS notice_receipts');
  },
};
