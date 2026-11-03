'use strict';
/** Module 09 section 7.1: the foreign key from module 03 `invitations.residentId` to `residents.id` (ON DELETE SET NULL), which module 03 left for this module. */
const FK = 'fk_invitations_resident';

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
    // an invitation can only point at a resident that exists (rows written before the residents table existed)
    await qi.sequelize.query(
      'UPDATE invitations SET residentId = NULL WHERE residentId IS NOT NULL AND residentId NOT IN (SELECT id FROM residents)',
    );
    await qi.sequelize.query(
      `ALTER TABLE invitations ADD CONSTRAINT ${FK} FOREIGN KEY (residentId) REFERENCES residents (id) ON DELETE SET NULL`,
    );
  },
  async down(qi) {
    if (!(await fkExists(qi))) return;
    await qi.sequelize.query(`ALTER TABLE invitations DROP FOREIGN KEY ${FK}`);
  },
};
