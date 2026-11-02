'use strict';
/** Module 08 section 7: the foreign key from module 03 `invitations.unitId` to `units.id`, which module 03 left for this module. */
const FK = 'fk_invitations_unit';

async function fkExists(qi) {
  const [rows] = await qi.sequelize.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'invitations' AND CONSTRAINT_NAME = '${FK}' AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
  );
  return rows.length > 0;
}

module.exports = {
  async up(qi) {
    if (await fkExists(qi)) return;
    // an invitation can only point at a unit that exists (rows written before the units table existed)
    await qi.sequelize.query(
      'UPDATE invitations SET unitId = NULL WHERE unitId IS NOT NULL AND unitId NOT IN (SELECT id FROM units)',
    );
    await qi.sequelize.query(
      `ALTER TABLE invitations ADD CONSTRAINT ${FK} FOREIGN KEY (unitId) REFERENCES units (id) ON DELETE RESTRICT`,
    );
  },
  async down(qi) {
    if (!(await fkExists(qi))) return;
    await qi.sequelize.query(`ALTER TABLE invitations DROP FOREIGN KEY ${FK}`);
  },
};
