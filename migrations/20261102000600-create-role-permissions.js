'use strict';
/** Module 03 section 7.3. Rows are never updated; a change deletes and inserts. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE role_permissions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NULL,
        roleId BIGINT UNSIGNED NOT NULL,
        permissionId BIGINT UNSIGNED NOT NULL,
        createdBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_role_perm (roleId, permissionId),
        KEY ix_role_perm_permission (permissionId),
        KEY ix_role_perm_society (societyId),
        CONSTRAINT fk_role_perm_role FOREIGN KEY (roleId) REFERENCES roles (id) ON DELETE CASCADE,
        CONSTRAINT fk_role_perm_permission FOREIGN KEY (permissionId) REFERENCES permissions (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS role_permissions');
  },
};
