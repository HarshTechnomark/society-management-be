'use strict';
/**
 * Module 09 part 2: a DRAFT tenancy must remember the household members to link and whether to invite the tenant on
 * approval (BR-09-31), and section 7.3 has no column for either.
 */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(
      'ALTER TABLE tenancies ADD COLUMN householdJson JSON NULL AFTER occupantCount, ADD COLUMN inviteTenant TINYINT(1) NOT NULL DEFAULT 1 AFTER householdJson',
    );
  },
  async down(qi) {
    await qi.sequelize.query('ALTER TABLE tenancies DROP COLUMN inviteTenant, DROP COLUMN householdJson');
  },
};
