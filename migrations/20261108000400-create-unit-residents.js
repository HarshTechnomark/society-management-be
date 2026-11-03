'use strict';
/**
 * Module 09 section 7.2: one row per period a resident is connected to a unit. Never deleted, ended with `toDate`.
 * The generated slot columns back the unique keys: one open link per resident and unit, one open OWNER per unit, one primary
 * per unit. The service clears `isPrimary` whenever it sets `toDate`.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE unit_residents (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        unitId BIGINT UNSIGNED NOT NULL,
        residentId BIGINT UNSIGNED NOT NULL,
        relation VARCHAR(12) NOT NULL,
        familyRelation VARCHAR(12) NULL,
        sharePercent DECIMAL(9,4) NULL,
        isPrimary TINYINT(1) NOT NULL DEFAULT 0,
        isResiding TINYINT(1) NOT NULL DEFAULT 1,
        canLogin TINYINT(1) NOT NULL DEFAULT 1,
        tenancyId BIGINT UNSIGNED NULL,
        ownershipTransferId BIGINT UNSIGNED NULL,
        fromDate DATE NOT NULL,
        toDate DATE NULL,
        endReason VARCHAR(16) NULL,
        endNote VARCHAR(300) NULL,
        source VARCHAR(20) NOT NULL DEFAULT 'ADMIN',
        openSlot BIGINT UNSIGNED GENERATED ALWAYS AS (IF(toDate IS NULL, residentId, NULL)) STORED,
        ownerSlot TINYINT GENERATED ALWAYS AS (IF(relation = 'OWNER' AND toDate IS NULL, 1, NULL)) STORED,
        primarySlot TINYINT GENERATED ALWAYS AS (IF(isPrimary = 1, 1, NULL)) STORED,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_ur_open (unitId, openSlot),
        UNIQUE KEY uq_ur_owner (unitId, ownerSlot),
        UNIQUE KEY uq_ur_primary (unitId, primarySlot),
        KEY ix_unit_residents_unit (societyId, unitId, toDate),
        KEY ix_ur_resident (societyId, residentId, toDate),
        KEY ix_ur_tenancy (tenancyId),
        KEY ix_ur_transfer (ownershipTransferId),
        KEY ix_ur_dates (societyId, fromDate, toDate),
        CONSTRAINT fk_ur_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ur_unit FOREIGN KEY (unitId) REFERENCES units (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ur_resident FOREIGN KEY (residentId) REFERENCES residents (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ur_tenancy FOREIGN KEY (tenancyId) REFERENCES tenancies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ur_transfer FOREIGN KEY (ownershipTransferId) REFERENCES ownership_transfers (id) ON DELETE RESTRICT,
        CONSTRAINT ck_ur_relation CHECK (relation IN ('OWNER','CO_OWNER','TENANT','FAMILY','CARETAKER')),
        CONSTRAINT ck_ur_family_relation CHECK (familyRelation IS NULL OR familyRelation IN ('SPOUSE','CHILD','PARENT','SIBLING','GRANDPARENT','GRANDCHILD','RELATIVE','OTHER')),
        CONSTRAINT ck_ur_share_range CHECK (sharePercent IS NULL OR (sharePercent >= 0.01 AND sharePercent <= 100)),
        CONSTRAINT ck_ur_bools CHECK (isPrimary IN (0,1) AND isResiding IN (0,1) AND canLogin IN (0,1)),
        CONSTRAINT ck_ur_end_reason CHECK (endReason IS NULL OR endReason IN ('MOVED_OUT','SOLD','TRANSFERRED','TENANCY_ENDED','TERMINATED','DECEASED','CORRECTION','REMOVED','OTHER')),
        CONSTRAINT ck_ur_source CHECK (source IN ('ADMIN','IMPORT','JOIN_REQUEST','HOUSEHOLD','TENANCY','TRANSFER')),
        CONSTRAINT ck_ur_share CHECK (sharePercent IS NULL OR relation IN ('OWNER','CO_OWNER')),
        CONSTRAINT ck_ur_primary CHECK (isPrimary = 0 OR relation IN ('OWNER','CO_OWNER')),
        CONSTRAINT ck_ur_family CHECK ((relation = 'FAMILY') = (familyRelation IS NOT NULL)),
        CONSTRAINT ck_ur_dates CHECK (toDate IS NULL OR toDate >= DATE_SUB(fromDate, INTERVAL 1 DAY)),
        CONSTRAINT ck_ur_end CHECK ((toDate IS NULL) = (endReason IS NULL))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS unit_residents');
  },
};
