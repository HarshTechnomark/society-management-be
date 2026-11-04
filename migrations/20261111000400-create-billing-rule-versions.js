'use strict';
/**
 * Module 11 section 7 (billing): billing_rule_versions. Financial rows have no database FK to `units`, `residents` or `files` (BR-05-21: they
 * are kept after closure while modules 08/09 purge their own rows); those columns are indexed BIGINT snapshots.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE billing_rule_versions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        billingRuleId BIGINT UNSIGNED NOT NULL,
        versionNo SMALLINT UNSIGNED NOT NULL,
        rateType VARCHAR(20) NOT NULL,
        amountPaise BIGINT NULL,
        ratePerSqftPaise BIGINT NULL,
        unitTypeRates JSON NULL,
        meterType VARCHAR(12) NULL,
        slabs JSON NULL,
        minimumChargePaise BIGINT NULL,
        missingReadingPolicy VARCHAR(16) NULL,
        billSplitRuleId BIGINT UNSIGNED NULL,
        percent DECIMAL(9,4) NULL,
        baseChargeHeadIds JSON NULL,
        effectiveFrom DATE NOT NULL,
        effectiveTo DATE NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING_APPROVAL',
        reason VARCHAR(500) NOT NULL,
        resolutionRef VARCHAR(100) NULL,
        approvalRequestId BIGINT UNSIGNED NULL,
        approvedBy BIGINT UNSIGNED NULL,
        approvedAt DATETIME(3) NULL,
        rejectedReason VARCHAR(500) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_rule_versions_no (billingRuleId, versionNo),
        KEY ix_rule_versions_effective (societyId, billingRuleId, status, effectiveFrom),
        KEY ix_rule_versions_split (billSplitRuleId),
        CONSTRAINT fk_rule_versions_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_rule_versions_rule FOREIGN KEY (billingRuleId) REFERENCES billing_rules (id) ON DELETE RESTRICT,
        CONSTRAINT fk_rule_versions_split FOREIGN KEY (billSplitRuleId) REFERENCES bill_split_rules (id) ON DELETE RESTRICT,
        CONSTRAINT ck_rv_rate_type CHECK (rateType IN ('FLAT_PER_UNIT','PER_SQFT','PER_UNIT_TYPE','METERED','SPLIT_TOTAL','PERCENT_OF_HEADS','NONE')),
        CONSTRAINT ck_rv_meter CHECK (meterType IS NULL OR meterType IN ('WATER','ELECTRICITY','GAS')),
        CONSTRAINT ck_rv_missing CHECK (missingReadingPolicy IS NULL OR missingReadingPolicy IN ('EXCEPTION','MINIMUM_CHARGE')),
        CONSTRAINT ck_rv_status CHECK (status IN ('PENDING_APPROVAL','APPROVED','REJECTED')),
        CONSTRAINT ck_rv_dates CHECK (effectiveTo IS NULL OR effectiveTo >= effectiveFrom),
        CONSTRAINT ck_rv_flat_per_unit CHECK (rateType <> 'FLAT_PER_UNIT' OR (amountPaise IS NOT NULL AND baseChargeHeadIds IS NULL AND billSplitRuleId IS NULL AND meterType IS NULL AND minimumChargePaise IS NULL AND missingReadingPolicy IS NULL AND percent IS NULL AND ratePerSqftPaise IS NULL AND slabs IS NULL AND unitTypeRates IS NULL AND amountPaise BETWEEN 0 AND 100000000)),
        CONSTRAINT ck_rv_per_sqft CHECK (rateType <> 'PER_SQFT' OR (amountPaise IS NULL AND baseChargeHeadIds IS NULL AND billSplitRuleId IS NULL AND meterType IS NULL AND minimumChargePaise IS NULL AND missingReadingPolicy IS NULL AND percent IS NULL AND ratePerSqftPaise IS NOT NULL AND slabs IS NULL AND unitTypeRates IS NULL AND ratePerSqftPaise BETWEEN 1 AND 100000)),
        CONSTRAINT ck_rv_per_unit_type CHECK (rateType <> 'PER_UNIT_TYPE' OR (amountPaise IS NULL AND baseChargeHeadIds IS NULL AND billSplitRuleId IS NULL AND meterType IS NULL AND minimumChargePaise IS NULL AND missingReadingPolicy IS NULL AND percent IS NULL AND ratePerSqftPaise IS NULL AND slabs IS NULL AND unitTypeRates IS NOT NULL AND JSON_TYPE(unitTypeRates) = 'OBJECT' AND JSON_LENGTH(unitTypeRates) BETWEEN 1 AND 50)),
        CONSTRAINT ck_rv_metered CHECK (rateType <> 'METERED' OR (amountPaise IS NULL AND baseChargeHeadIds IS NULL AND billSplitRuleId IS NULL AND meterType IS NOT NULL AND minimumChargePaise IS NOT NULL AND missingReadingPolicy IS NOT NULL AND percent IS NULL AND ratePerSqftPaise IS NULL AND slabs IS NOT NULL AND unitTypeRates IS NULL AND JSON_TYPE(slabs) = 'ARRAY' AND JSON_LENGTH(slabs) >= 1 AND minimumChargePaise BETWEEN 0 AND 10000000)),
        CONSTRAINT ck_rv_split_total CHECK (rateType <> 'SPLIT_TOTAL' OR (amountPaise IS NULL AND baseChargeHeadIds IS NULL AND billSplitRuleId IS NOT NULL AND meterType IS NULL AND minimumChargePaise IS NULL AND missingReadingPolicy IS NULL AND percent IS NULL AND ratePerSqftPaise IS NULL AND slabs IS NULL AND unitTypeRates IS NULL)),
        CONSTRAINT ck_rv_percent_of_heads CHECK (rateType <> 'PERCENT_OF_HEADS' OR (amountPaise IS NULL AND baseChargeHeadIds IS NOT NULL AND billSplitRuleId IS NULL AND meterType IS NULL AND minimumChargePaise IS NULL AND missingReadingPolicy IS NULL AND percent IS NOT NULL AND ratePerSqftPaise IS NULL AND slabs IS NULL AND unitTypeRates IS NULL AND percent BETWEEN 0.0001 AND 100 AND JSON_TYPE(baseChargeHeadIds) = 'ARRAY' AND JSON_LENGTH(baseChargeHeadIds) BETWEEN 1 AND 10)),
        CONSTRAINT ck_rv_none CHECK (rateType <> 'NONE' OR (amountPaise IS NULL AND baseChargeHeadIds IS NULL AND billSplitRuleId IS NULL AND meterType IS NULL AND minimumChargePaise IS NULL AND missingReadingPolicy IS NULL AND percent IS NULL AND ratePerSqftPaise IS NULL AND slabs IS NULL AND unitTypeRates IS NULL))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS billing_rule_versions');
  },
};
