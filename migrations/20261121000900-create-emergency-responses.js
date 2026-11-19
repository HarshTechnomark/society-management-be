'use strict';
/** Module 16 section 7.9: `emergency_responses`. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE emergency_responses (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        broadcastId BIGINT UNSIGNED NOT NULL,
        subjectKey VARCHAR(40) NOT NULL,
        unitId BIGINT UNSIGNED NULL,
        userId BIGINT UNSIGNED NULL,
        recordedBy BIGINT UNSIGNED NOT NULL,
        status VARCHAR(10) NOT NULL,
        peopleCount TINYINT UNSIGNED NOT NULL DEFAULT 1,
        note VARCHAR(300) NULL,
        channel VARCHAR(12) NOT NULL,
        isLatest TINYINT(1) NOT NULL DEFAULT 1,
        latestKey VARCHAR(40) GENERATED ALWAYS AS (IF(isLatest = 1, subjectKey, NULL)) STORED,
        attendedBy BIGINT UNSIGNED NULL,
        attendedAt DATETIME(3) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_emergency_resp_latest (broadcastId, latestKey),
        KEY ix_emergency_resp_broadcast (broadcastId, status, isLatest),
        KEY ix_emergency_resp_unit (broadcastId, unitId),
        CONSTRAINT fk_emergency_resp_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_emergency_resp_broadcast FOREIGN KEY (broadcastId) REFERENCES emergency_broadcasts (id) ON DELETE RESTRICT,
        CONSTRAINT fk_emergency_resp_unit FOREIGN KEY (unitId) REFERENCES units (id) ON DELETE RESTRICT,
        CONSTRAINT fk_emergency_resp_user FOREIGN KEY (userId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_emergency_resp_recorded_by FOREIGN KEY (recordedBy) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_emergency_resp_attended_by FOREIGN KEY (attendedBy) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT ck_emergency_resp_status CHECK (status IN ('SAFE','NEED_HELP')),
        CONSTRAINT ck_emergency_resp_people CHECK (peopleCount BETWEEN 1 AND 20),
        CONSTRAINT ck_emergency_resp_channel CHECK (channel IN ('APP','PUSH_ACTION','WHATSAPP','GATE','ADMIN'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS emergency_responses');
  },
};
