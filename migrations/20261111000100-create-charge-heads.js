'use strict';
/**
 * Module 11 section 7 (billing): charge_heads. No database FK to `units`, `residents` or `files`: financial rows are kept after a
 * society is closed (BR-05-21) while module 08/09 purge their own rows, so those columns are plain indexed BIGINT snapshots.
 * (charge_heads: "sacCode required when taxed" is a service check at publish, because section 7.13 seeds every head with a NULL sacCode.)
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE charge_heads (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        \`key\` VARCHAR(40) NOT NULL,
        name VARCHAR(80) NOT NULL,
        description VARCHAR(300) NULL,
        headType VARCHAR(30) NOT NULL,
        payerRouting VARCHAR(10) NOT NULL DEFAULT 'BILL_TO',
        gstTreatment VARCHAR(15) NOT NULL DEFAULT 'NONE',
        sacCode VARCHAR(8) NULL,
        prorate BOOLEAN NOT NULL DEFAULT true,
        interestBearing BOOLEAN NOT NULL DEFAULT true,
        ledgerAccountCode VARCHAR(40) NOT NULL,
        fundId BIGINT UNSIGNED NULL,
        isSystem BOOLEAN NOT NULL DEFAULT false,
        status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
        sortOrder SMALLINT UNSIGNED NOT NULL DEFAULT 100,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_charge_heads_key (societyId, \`key\`),
        KEY ix_charge_heads_status (societyId, status, sortOrder),
        CONSTRAINT fk_charge_heads_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT ck_charge_heads_key CHECK (\`key\` REGEXP '^[A-Z][A-Z0-9_]{1,39}$'),
        CONSTRAINT ck_charge_heads_type CHECK (headType IN ('MAINTENANCE','SINKING_FUND','REPAIR_FUND','PARKING','WATER','ELECTRICITY','NON_OCCUPANCY','FESTIVAL','COLLECTION','BOUNCE_CHARGE','MEMBERSHIP','DEPOSIT','AMENITY','FINE','SERVICE','TRANSFER','INTEREST','LATE_FEE','OPENING_ARREARS','OTHER')),
        CONSTRAINT ck_charge_heads_routing CHECK (payerRouting IN ('OWNER','BILL_TO')),
        CONSTRAINT ck_charge_heads_gst CHECK (gstTreatment IN ('NONE','THRESHOLD','ALWAYS','FOLLOW_SOURCE')),
        CONSTRAINT ck_charge_heads_follow CHECK (gstTreatment <> 'FOLLOW_SOURCE' OR headType IN ('INTEREST','LATE_FEE')),
        CONSTRAINT ck_charge_heads_sac CHECK (sacCode IS NULL OR sacCode REGEXP '^[0-9]{4,8}$'),
        CONSTRAINT ck_charge_heads_status CHECK (status IN ('ACTIVE','ARCHIVED')),
        CONSTRAINT ck_charge_heads_sort CHECK (sortOrder <= 999)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS charge_heads');
  },
};
