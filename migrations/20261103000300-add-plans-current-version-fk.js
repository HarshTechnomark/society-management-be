'use strict';
/** Module 04 section 7.1: the second migration step that adds `plans.currentVersionId` as a foreign key. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(
      'ALTER TABLE plans ADD CONSTRAINT fk_plans_current_version FOREIGN KEY (currentVersionId) REFERENCES plan_versions (id) ON DELETE RESTRICT',
    );
  },
  async down(qi) {
    await qi.sequelize.query('ALTER TABLE plans DROP FOREIGN KEY fk_plans_current_version');
  },
};
