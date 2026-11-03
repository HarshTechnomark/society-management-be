'use strict';
/** Module 08 section 7.5: the holiday calendar of a society (one holiday per date). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE holidays (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        holidayDate DATE NOT NULL,
        name VARCHAR(80) NOT NULL,
        holidayType VARCHAR(12) NOT NULL DEFAULT 'FESTIVAL',
        isOfficeClosed TINYINT(1) NOT NULL DEFAULT 1,
        notes VARCHAR(300) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_holidays_date (societyId, holidayDate),
        CONSTRAINT fk_holidays_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT ck_holidays_type CHECK (holidayType IN ('NATIONAL','FESTIVAL','SOCIETY','OTHER'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS holidays');
  },
};
