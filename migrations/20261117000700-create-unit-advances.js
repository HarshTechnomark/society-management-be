'use strict';
/** Module 12 section 7.7: unit_advances, the append-only unit wallet ledger (latest row = balance). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE unit_advances (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        unitId BIGINT UNSIGNED NOT NULL,
        entryType VARCHAR(20) NOT NULL,
        amountPaise BIGINT NOT NULL,
        balanceAfterPaise BIGINT NOT NULL,
        paymentId BIGINT UNSIGNED NULL,
        refundId BIGINT UNSIGNED NULL,
        invoiceId BIGINT UNSIGNED NULL,
        dedupeKey VARCHAR(80) NOT NULL,
        narration VARCHAR(200) NOT NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_adv_dedupe (societyId, dedupeKey),
        KEY ix_adv_unit (societyId, unitId, id),
        KEY ix_adv_payment (paymentId),
        KEY ix_adv_refund (refundId),
        CONSTRAINT fk_adv_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_adv_payment FOREIGN KEY (paymentId) REFERENCES payments (id) ON DELETE RESTRICT,
        CONSTRAINT fk_adv_refund FOREIGN KEY (refundId) REFERENCES refunds (id) ON DELETE RESTRICT,
        CONSTRAINT ck_adv_type CHECK (entryType IN ('PAYMENT_EXCESS','OPENING','APPLIED','ALLOCATION_RELEASED','EXCESS_REVERSED','REFUND_HOLD','REFUND_RELEASE')),
        CONSTRAINT ck_adv_amount CHECK (amountPaise <> 0 AND ((entryType IN ('PAYMENT_EXCESS','OPENING','ALLOCATION_RELEASED','REFUND_RELEASE') AND amountPaise > 0) OR (entryType IN ('APPLIED','EXCESS_REVERSED','REFUND_HOLD') AND amountPaise < 0))),
        CONSTRAINT ck_adv_balance CHECK (balanceAfterPaise >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS unit_advances');
  },
};
