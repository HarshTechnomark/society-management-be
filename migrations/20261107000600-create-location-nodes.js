'use strict';
/** Module 08 section 7.6: tree of buildings, floors and common areas with a materialized path and a QR token per node. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE location_nodes (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        parentId BIGINT UNSIGNED NULL,
        nodeType VARCHAR(10) NOT NULL,
        areaType VARCHAR(20) NULL,
        name VARCHAR(80) NOT NULL,
        buildingId BIGINT UNSIGNED NULL,
        floor SMALLINT NULL,
        path VARCHAR(100) NOT NULL,
        depth TINYINT UNSIGNED NOT NULL,
        sortOrder SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        qrToken CHAR(12) NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
        archivedAt DATETIME(3) NULL,
        notes VARCHAR(300) NULL,
        parentKey BIGINT UNSIGNED GENERATED ALWAYS AS (IFNULL(parentId, 0)) STORED,
        activeNameKey VARCHAR(80) GENERATED ALWAYS AS (IF(status = 'ACTIVE', name, NULL)) STORED,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_location_nodes_sibling_name (societyId, parentKey, activeNameKey),
        UNIQUE KEY uq_location_nodes_qr (qrToken),
        KEY ix_location_nodes_path (societyId, path),
        KEY ix_location_nodes_building (societyId, buildingId, floor),
        KEY ix_location_nodes_parent (parentId),
        KEY ix_location_nodes_building_fk (buildingId),
        CONSTRAINT fk_location_nodes_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_location_nodes_parent FOREIGN KEY (parentId) REFERENCES location_nodes (id) ON DELETE RESTRICT,
        CONSTRAINT fk_location_nodes_building FOREIGN KEY (buildingId) REFERENCES buildings (id) ON DELETE RESTRICT,
        CONSTRAINT ck_loc_node_type CHECK (nodeType IN ('BUILDING','FLOOR','AREA')),
        CONSTRAINT ck_loc_status CHECK (status IN ('ACTIVE','ARCHIVED')),
        CONSTRAINT ck_loc_area_values CHECK (areaType IS NULL OR areaType IN ('LOBBY','LIFT','STAIRCASE','CORRIDOR','TERRACE','BASEMENT_PARKING','OPEN_PARKING','GARDEN','PLAYGROUND','GYM','POOL','CLUBHOUSE','HALL','PUMP_ROOM','STP','WTP','ELECTRICAL_ROOM','DG_ROOM','METER_ROOM','WATER_TANK','GARBAGE_AREA','SECURITY_CABIN','GATE','OFFICE','OTHER')),
        CONSTRAINT ck_loc_area_type CHECK ((nodeType = 'AREA') = (areaType IS NOT NULL)),
        CONSTRAINT ck_loc_floor CHECK (nodeType <> 'FLOOR' OR floor IS NOT NULL),
        CONSTRAINT ck_loc_building CHECK (nodeType <> 'BUILDING' OR (buildingId IS NOT NULL AND parentId IS NULL)),
        CONSTRAINT ck_loc_depth CHECK (depth BETWEEN 1 AND 4),
        CONSTRAINT ck_loc_qr CHECK (REGEXP_LIKE(qrToken, '^[A-Za-z0-9]{12}$', 'c'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS location_nodes');
  },
};
