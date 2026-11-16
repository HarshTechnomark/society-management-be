'use strict';
/** Module 12 section 7.3: payment_allocations, append-only; a reversal is a new negative row with `reversalOfId`. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE payment_allocations (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        unitId BIGINT UNSIGNED NOT NULL,
        source VARCHAR(10) NOT NULL,
        paymentId BIGINT UNSIGNED NULL,
        unitAdvanceId BIGINT UNSIGNED NULL,
        targetType VARCHAR(20) NOT NULL,
        invoiceId BIGINT UNSIGNED NULL,
        collectionRequestId BIGINT UNSIGNED NULL,
        amountPaise BIGINT NOT NULL,
        reversalOfId BIGINT UNSIGNED NULL,
        reasonCode VARCHAR(20) NOT NULL DEFAULT 'ALLOCATED',
        allocatedOn DATE NOT NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_alloc_reversal (reversalOfId),
        KEY ix_alloc_payment (paymentId),
        KEY ix_alloc_invoice (societyId, invoiceId),
        KEY ix_alloc_request (societyId, collectionRequestId),
        KEY ix_alloc_unit (societyId, unitId, createdAt),
        CONSTRAINT fk_alloc_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_alloc_payment FOREIGN KEY (paymentId) REFERENCES payments (id) ON DELETE RESTRICT,
        CONSTRAINT fk_alloc_advance FOREIGN KEY (unitAdvanceId) REFERENCES unit_advances (id) ON DELETE RESTRICT,
        CONSTRAINT fk_alloc_request FOREIGN KEY (collectionRequestId) REFERENCES collection_requests (id) ON DELETE RESTRICT,
        CONSTRAINT fk_alloc_reversal FOREIGN KEY (reversalOfId) REFERENCES payment_allocations (id) ON DELETE RESTRICT,
        CONSTRAINT ck_alloc_source CHECK (source IN ('PAYMENT','ADVANCE')),
        CONSTRAINT ck_alloc_source_ref CHECK ((source = 'PAYMENT') = (paymentId IS NOT NULL) AND (source = 'ADVANCE') = (unitAdvanceId IS NOT NULL)),
        CONSTRAINT ck_alloc_target CHECK (targetType IN ('INVOICE','COLLECTION_REQUEST') AND ((targetType = 'INVOICE' AND invoiceId IS NOT NULL AND collectionRequestId IS NULL) OR (targetType = 'COLLECTION_REQUEST' AND collectionRequestId IS NOT NULL AND invoiceId IS NULL))),
        CONSTRAINT ck_alloc_amount CHECK (amountPaise <> 0 AND (amountPaise > 0 OR reversalOfId IS NOT NULL)),
        CONSTRAINT ck_alloc_reason CHECK (reasonCode IN ('ALLOCATED','REALLOCATED','BOUNCED','RETURNED','REVERSED','REFUND_FREED','INVOICE_CANCELLED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS payment_allocations');
  },
};
