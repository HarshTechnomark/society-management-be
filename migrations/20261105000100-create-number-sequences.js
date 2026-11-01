'use strict';
/**
 * Module 01 section 7.5 (added with module 06, the first module that numbers documents). One row per society, series and
 * financial year; `societyId = 0` is the platform (PLT, PCN). `nextNumber()` locks the row inside the caller's transaction.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE number_sequences (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL DEFAULT 0,
        series VARCHAR(30) NOT NULL,
        financialYear CHAR(7) NOT NULL,
        prefix VARCHAR(12) NOT NULL,
        nextValue INT UNSIGNED NOT NULL DEFAULT 1,
        padding TINYINT UNSIGNED NOT NULL DEFAULT 6,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_seq (societyId, series, financialYear),
        CONSTRAINT ck_seq_series CHECK (series IN ('INVOICE','CREDIT_NOTE','DEBIT_NOTE','RECEIPT','REFUND','VOUCHER','JOURNAL','PURCHASE_ORDER','BOOKING','TICKET','PARKING_STICKER','PARKING_VIOLATION','PARKING_LOTTERY','WORK_ORDER','VENDOR_BILL','MEETING','RESOLUTION','CERTIFICATE','SHARE_CERTIFICATE','PLATFORM_INVOICE','PLATFORM_CREDIT_NOTE')),
        CONSTRAINT ck_seq_fy CHECK (financialYear REGEXP '^[0-9]{4}-[0-9]{2}$'),
        CONSTRAINT ck_seq_next CHECK (nextValue >= 1),
        CONSTRAINT ck_seq_padding CHECK (padding BETWEEN 4 AND 8)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS number_sequences');
  },
};
