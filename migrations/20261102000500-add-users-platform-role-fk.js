'use strict';
/** Module 03 section 7.6a: the foreign key from the module 02 column `users.platformRoleId` to `roles.id`. Down drops the key only. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(
      'ALTER TABLE users ADD CONSTRAINT fk_users_platform_role FOREIGN KEY (platformRoleId) REFERENCES roles (id) ON DELETE RESTRICT',
    );
  },
  async down(qi) {
    await qi.sequelize.query('ALTER TABLE users DROP FOREIGN KEY fk_users_platform_role');
  },
};
