'use strict';
/** Module 06 section 7.2. Immutable lines of an invoice or credit note (the model hooks throw on update and delete). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE platform_invoice_lines (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        invoiceId BIGINT UNSIGNED NOT NULL,
        lineNo SMALLINT UNSIGNED NOT NULL,
        lineType VARCHAR(20) NOT NULL,
        description VARCHAR(300) NOT NULL,
        sacCode CHAR(6) NOT NULL,
        quantity DECIMAL(12,4) NOT NULL,
        unitPricePaise BIGINT NOT NULL DEFAULT 0,
        amountPaise BIGINT NOT NULL,
        planVersionId BIGINT UNSIGNED NULL,
        addonKey VARCHAR(40) NULL,
        limitKey VARCHAR(40) NULL,
        servicePeriodStart DATE NULL,
        servicePeriodEnd DATE NULL,
        prorationDays SMALLINT UNSIGNED NULL,
        periodDays SMALLINT UNSIGNED NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_pinvl_invoice_line (invoiceId, lineNo),
        KEY ix_pinvl_society (societyId),
        KEY ix_pinvl_plan_version (planVersionId),
        CONSTRAINT fk_pinvl_invoice FOREIGN KEY (invoiceId) REFERENCES platform_invoices (id) ON DELETE RESTRICT,
        CONSTRAINT fk_pinvl_plan_version FOREIGN KEY (planVersionId) REFERENCES plan_versions (id) ON DELETE RESTRICT,
        CONSTRAINT ck_pinvl_line_no CHECK (lineNo >= 1),
        CONSTRAINT ck_pinvl_type CHECK (lineType IN ('PLAN','DISCOUNT','ADDON','FLAT_TRUE_UP','OVERAGE','PRORATION','ONE_TIME','MANUAL','CREDIT_NOTE')),
        CONSTRAINT ck_pinvl_sac CHECK (sacCode REGEXP '^[0-9]{6}$'),
        CONSTRAINT ck_pinvl_quantity CHECK (quantity > 0),
        CONSTRAINT ck_pinvl_amount CHECK (amountPaise <> 0 AND (amountPaise > 0 OR lineType IN ('DISCOUNT','PRORATION'))),
        CONSTRAINT ck_pinvl_period CHECK (servicePeriodStart IS NULL OR servicePeriodEnd IS NULL OR servicePeriodEnd >= servicePeriodStart),
        CONSTRAINT ck_pinvl_updated_by CHECK (updatedBy IS NULL)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS platform_invoice_lines');
  },
};
