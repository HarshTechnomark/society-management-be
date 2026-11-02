'use strict';
/** Module 08 section 7.1: towers, wings, blocks and other buildings of a society. Archive is a status, never paranoid. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE buildings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        parentBuildingId BIGINT UNSIGNED NULL,
        code VARCHAR(6) NOT NULL,
        name VARCHAR(80) NOT NULL,
        kind VARCHAR(20) NOT NULL DEFAULT 'TOWER',
        floorsAboveGround SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        basements TINYINT UNSIGNED NOT NULL DEFAULT 0,
        liftCount TINYINT UNSIGNED NOT NULL DEFAULT 0,
        sortOrder SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
        archivedAt DATETIME(3) NULL,
        archivedReason VARCHAR(300) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_buildings_code (societyId, code),
        KEY ix_buildings_society_status (societyId, status, sortOrder),
        KEY ix_buildings_parent (parentBuildingId),
        CONSTRAINT fk_buildings_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_buildings_parent FOREIGN KEY (parentBuildingId) REFERENCES buildings (id) ON DELETE RESTRICT,
        CONSTRAINT ck_buildings_kind CHECK (kind IN ('TOWER','WING','ROW_HOUSES','VILLA_CLUSTER','COMMERCIAL','CLUBHOUSE','OTHER')),
        CONSTRAINT ck_buildings_status CHECK (status IN ('ACTIVE','ARCHIVED')),
        CONSTRAINT ck_buildings_floors CHECK (floorsAboveGround <= 200),
        CONSTRAINT ck_buildings_basements CHECK (basements <= 5),
        CONSTRAINT ck_buildings_lifts CHECK (liftCount <= 50),
        CONSTRAINT ck_buildings_sort CHECK (sortOrder <= 9999),
        CONSTRAINT ck_buildings_code CHECK (REGEXP_LIKE(code, '^[A-Z0-9]{1,6}$', 'c')),
        CONSTRAINT ck_buildings_wing CHECK ((kind = 'WING') = (parentBuildingId IS NOT NULL)),
        CONSTRAINT ck_buildings_archived CHECK ((status = 'ARCHIVED') = (archivedAt IS NOT NULL))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS buildings');
  },
};
