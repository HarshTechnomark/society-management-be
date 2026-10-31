'use strict';
/** Module 03 section 7.1: the permission catalogue, written only by the seeder. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE permissions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`key\` VARCHAR(80) NOT NULL,
        scope VARCHAR(10) NOT NULL,
        master VARCHAR(30) NOT NULL,
        subMaster VARCHAR(30) NOT NULL,
        action VARCHAR(10) NOT NULL,
        label VARCHAR(120) NOT NULL,
        description VARCHAR(255) NULL,
        moduleNo TINYINT UNSIGNED NOT NULL,
        isPrivileged TINYINT(1) NOT NULL DEFAULT 0,
        sortOrder SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_permissions_key (\`key\`),
        KEY ix_permissions_scope (scope, master, subMaster, sortOrder),
        CONSTRAINT ck_permissions_scope CHECK (scope IN ('platform','society','resident','gate','work')),
        CONSTRAINT ck_permissions_action CHECK (action IN ('view','create','edit','delete','import','export','approve')),
        CONSTRAINT ck_permissions_key CHECK (\`key\` REGEXP '^[a-z_]+\\\\.[a-z_]+\\\\.(view|create|edit|delete|import|export|approve)$')
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS permissions');
  },
};
