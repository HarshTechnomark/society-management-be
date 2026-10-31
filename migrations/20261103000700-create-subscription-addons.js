'use strict';
/** Module 04 section 7.6. Price, billing type and grants are snapshots of the add-on at purchase. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE subscription_addons (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        subscriptionId BIGINT UNSIGNED NOT NULL,
        addonId BIGINT UNSIGNED NOT NULL,
        addonCode VARCHAR(40) NOT NULL,
        billingType VARCHAR(10) NOT NULL,
        grants JSON NOT NULL,
        featureKey VARCHAR(80) NULL,
        quantity SMALLINT UNSIGNED NOT NULL DEFAULT 1,
        unitPricePaise BIGINT NOT NULL,
        periodKey VARCHAR(10) NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        startsAt DATETIME(3) NOT NULL,
        endsAt DATETIME(3) NULL,
        invoiceId BIGINT UNSIGNED NULL,
        endedReason VARCHAR(20) NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        KEY ix_sub_addons_society_status (societyId, status),
        KEY ix_sub_addons_subscription (subscriptionId, status),
        KEY ix_sub_addons_ends (status, endsAt),
        KEY ix_sub_addons_addon (addonId),
        KEY ix_sub_addons_invoice (invoiceId),
        KEY ix_sub_addons_period (societyId, addonCode, periodKey),
        CONSTRAINT fk_sub_addons_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_sub_addons_subscription FOREIGN KEY (subscriptionId) REFERENCES subscriptions (id) ON DELETE RESTRICT,
        CONSTRAINT fk_sub_addons_addon FOREIGN KEY (addonId) REFERENCES addons (id) ON DELETE RESTRICT,
        CONSTRAINT ck_sub_addons_billing CHECK (billingType IN ('ONE_TIME','RECURRING')),
        CONSTRAINT ck_sub_addons_qty CHECK (quantity BETWEEN 1 AND 100),
        CONSTRAINT ck_sub_addons_price CHECK (unitPricePaise >= 0),
        CONSTRAINT ck_sub_addons_status CHECK (status IN ('PENDING_PAYMENT','ACTIVE','CANCEL_SCHEDULED','ENDED')),
        CONSTRAINT ck_sub_addons_reason CHECK (endedReason IS NULL OR endedReason IN ('CANCELLED','EXPIRED','PLAN_CHANGED','INCLUDED_IN_PLAN','SUBSCRIPTION_CANCELLED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS subscription_addons');
  },
};
