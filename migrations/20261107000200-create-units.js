'use strict';
/**
 * Module 08 section 7.2: flats, shops, offices and parking-only units. `activeNumberKey` and `activeLabelKey` are
 * generated so that only ACTIVE units compete for a number (archived units never collide: MySQL unique keys allow NULLs).
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE units (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        buildingId BIGINT UNSIGNED NOT NULL,
        unitNumber VARCHAR(20) NOT NULL,
        label VARCHAR(27) NOT NULL,
        floor SMALLINT NOT NULL,
        positionOnFloor TINYINT UNSIGNED NULL,
        unitType VARCHAR(20) NOT NULL DEFAULT 'FLAT',
        bhk VARCHAR(10) NULL,
        carpetAreaSqft DECIMAL(10,3) NULL,
        builtUpAreaSqft DECIMAL(10,3) NULL,
        superBuiltUpAreaSqft DECIMAL(10,3) NULL,
        areaSqft DECIMAL(10,3) NULL,
        undividedSharePct DECIMAL(9,4) NULL,
        isBillable TINYINT(1) NOT NULL DEFAULT 1,
        possessionDate DATE NULL,
        notes VARCHAR(500) NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
        archivedAt DATETIME(3) NULL,
        archivedReason VARCHAR(300) NULL,
        archivedBy BIGINT UNSIGNED NULL,
        activeNumberKey VARCHAR(20) GENERATED ALWAYS AS (IF(status = 'ACTIVE', unitNumber, NULL)) STORED,
        activeLabelKey VARCHAR(27) GENERATED ALWAYS AS (IF(status = 'ACTIVE', label, NULL)) STORED,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_units_active_number (societyId, buildingId, activeNumberKey),
        UNIQUE KEY uq_units_active_label (societyId, activeLabelKey),
        KEY ix_units_society_status_type (societyId, status, unitType),
        KEY ix_units_building_floor (buildingId, floor, positionOnFloor),
        KEY ix_units_society_label (societyId, label),
        CONSTRAINT fk_units_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_units_building FOREIGN KEY (buildingId) REFERENCES buildings (id) ON DELETE RESTRICT,
        CONSTRAINT ck_units_type CHECK (unitType IN ('FLAT','SHOP','OFFICE','PARKING_ONLY')),
        CONSTRAINT ck_units_status CHECK (status IN ('ACTIVE','ARCHIVED')),
        CONSTRAINT ck_units_bhk_values CHECK (bhk IS NULL OR bhk IN ('STUDIO','1RK','1BHK','1_5BHK','2BHK','2_5BHK','3BHK','3_5BHK','4BHK','5BHK_PLUS')),
        CONSTRAINT ck_units_floor CHECK (floor BETWEEN -5 AND 200),
        CONSTRAINT ck_units_position CHECK (positionOnFloor IS NULL OR positionOnFloor BETWEEN 1 AND 50),
        CONSTRAINT ck_units_area_order CHECK (
          (carpetAreaSqft IS NULL OR builtUpAreaSqft IS NULL OR carpetAreaSqft <= builtUpAreaSqft)
          AND (builtUpAreaSqft IS NULL OR superBuiltUpAreaSqft IS NULL OR builtUpAreaSqft <= superBuiltUpAreaSqft)),
        CONSTRAINT ck_units_bhk CHECK (bhk IS NULL OR unitType = 'FLAT'),
        CONSTRAINT ck_units_share CHECK (undividedSharePct IS NULL OR (undividedSharePct > 0 AND undividedSharePct <= 100)),
        CONSTRAINT ck_units_archived CHECK ((status = 'ARCHIVED') = (archivedAt IS NOT NULL))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS units');
  },
};
