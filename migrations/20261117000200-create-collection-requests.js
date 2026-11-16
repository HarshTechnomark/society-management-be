'use strict';
/** Module 12 section 7.9: one row per unit asked to pay in a published collection. `unitId`, `billToResidentId` and `invoiceId` are plain ids (financial rows outlive module 08/09 purges). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE collection_requests (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        collectionId BIGINT UNSIGNED NOT NULL,
        unitId BIGINT UNSIGNED NOT NULL,
        billToResidentId BIGINT UNSIGNED NULL,
        amountPaise BIGINT NOT NULL DEFAULT 0,
        minAmountPaise BIGINT NOT NULL DEFAULT 0,
        paidPaise BIGINT NOT NULL DEFAULT 0,
        status VARCHAR(12) NOT NULL DEFAULT 'OPEN',
        invoiceId BIGINT UNSIGNED NULL,
        lastPaidAt DATETIME(3) NULL,
        waivedReason VARCHAR(300) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_creq_unit (collectionId, unitId),
        UNIQUE KEY uq_creq_invoice (invoiceId),
        KEY ix_creq_unit_status (societyId, unitId, status),
        KEY ix_creq_collection_status (collectionId, status),
        CONSTRAINT fk_creq_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_creq_collection FOREIGN KEY (collectionId) REFERENCES collections (id) ON DELETE RESTRICT,
        CONSTRAINT ck_creq_amounts CHECK (amountPaise >= 0 AND minAmountPaise >= 0 AND paidPaise >= 0),
        CONSTRAINT ck_creq_status CHECK (status IN ('OPEN','PART_PAID','PAID','WAIVED','CANCELLED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS collection_requests');
  },
};
