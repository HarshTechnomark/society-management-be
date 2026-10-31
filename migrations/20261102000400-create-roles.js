'use strict';
/** Module 03 section 7.2. `societyKey` is generated so platform roles (societyId NULL) share the unique keys. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE roles (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NULL,
        societyKey BIGINT UNSIGNED GENERATED ALWAYS AS (IFNULL(societyId, 0)) STORED NOT NULL,
        scope VARCHAR(10) NOT NULL,
        \`key\` VARCHAR(80) NOT NULL,
        name VARCHAR(80) NOT NULL,
        description VARCHAR(300) NULL,
        isSystem TINYINT(1) NOT NULL DEFAULT 0,
        requiresMfa TINYINT(1) NOT NULL DEFAULT 0,
        consumesSeat TINYINT(1) NOT NULL DEFAULT 0,
        basedOnRoleId BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        deletedAt DATETIME(3) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_roles_society_key (societyKey, \`key\`),
        UNIQUE KEY uq_roles_society_name (societyKey, name),
        KEY ix_roles_society_scope (societyId, scope, isSystem),
        KEY ix_roles_based_on (basedOnRoleId),
        CONSTRAINT fk_roles_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_roles_based_on FOREIGN KEY (basedOnRoleId) REFERENCES roles (id) ON DELETE SET NULL,
        CONSTRAINT ck_roles_scope CHECK (scope IN ('platform','society','resident','gate','work')),
        CONSTRAINT ck_roles_platform CHECK ((societyId IS NULL) = (scope = 'platform')),
        CONSTRAINT ck_roles_seat CHECK (scope = 'society' OR consumesSeat = 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS roles');
  },
};
