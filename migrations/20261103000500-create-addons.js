'use strict';
/** Module 04 section 7.4. Add-ons are never deleted; they are taken off sale. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE addons (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        code VARCHAR(40) NOT NULL,
        name VARCHAR(80) NOT NULL,
        description VARCHAR(300) NULL,
        billingType VARCHAR(10) NOT NULL,
        grants JSON NOT NULL,
        pricePaise BIGINT NOT NULL,
        minTierRank TINYINT UNSIGNED NOT NULL DEFAULT 1,
        maxTierRank TINYINT UNSIGNED NOT NULL DEFAULT 4,
        maxQuantity SMALLINT UNSIGNED NOT NULL DEFAULT 1,
        isOnSale TINYINT(1) NOT NULL DEFAULT 1,
        sortOrder SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_addons_code (code),
        KEY ix_addons_sale (isOnSale, sortOrder),
        CONSTRAINT ck_addons_billing CHECK (billingType IN ('ONE_TIME','RECURRING')),
        CONSTRAINT ck_addons_price CHECK (pricePaise >= 100),
        CONSTRAINT ck_addons_min CHECK (minTierRank BETWEEN 1 AND 4),
        CONSTRAINT ck_addons_max CHECK (maxTierRank BETWEEN 1 AND 4 AND maxTierRank >= minTierRank),
        CONSTRAINT ck_addons_qty CHECK (maxQuantity BETWEEN 1 AND 100)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS addons');
  },
};
