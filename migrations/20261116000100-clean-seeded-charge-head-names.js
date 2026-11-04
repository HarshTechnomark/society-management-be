'use strict';
/**
 * Module 11 section 7.13: the first seeded charge head names carried internal notes such as "Access card deposit
 * (module 13)". The seed now uses clean names. This renames the heads that still carry the old seeded text (matched by key
 * and exact old name), so a head a society renamed is left alone. `down` puts the old text back on heads that still carry
 * the clean name.
 */
const RENAMES = [
  ['AMENITY_DAMAGE', 'Amenity damage recovery (module 18)', 'Amenity damage recovery'],
  ['EV_CHARGING', 'EV charging (module 21 metered usage or module 19)', 'EV charging'],
  ['ACCESS_CARD_FEE', 'Access card replacement fee (module 17)', 'Access card replacement fee'],
  ['TRANSFER_PREMIUM', 'Transfer premium (module 09)', 'Transfer premium'],
  ['SHARE_TRANSFER_FEE', 'Share transfer fee (module 09)', 'Share transfer fee'],
  ['CERTIFICATE_FEE', 'Certificate fee (module 23)', 'Certificate fee'],
  ['ENTRANCE_FEE', 'Entrance fee (module 09)', 'Entrance fee'],
  ['RENOVATION_FEE', 'Renovation permit fee (module 09)', 'Renovation permit fee'],
  ['COLLECTION', 'Collection contribution (module 12)', 'Collection contribution'],
  ['CHEQUE_BOUNCE_CHARGE', 'Cheque bounce charge (module 12)', 'Cheque bounce charge'],
  ['DEPOSIT_RENOVATION', 'Renovation deposit (module 13)', 'Renovation deposit'],
  ['DEPOSIT_MOVE', 'Move-in / move-out deposit (module 13)', 'Move-in / move-out deposit'],
  ['DEPOSIT_AMENITY', 'Amenity booking deposit (module 13)', 'Amenity booking deposit'],
  ['DEPOSIT_ACCESS_CARD', 'Access card deposit (module 13)', 'Access card deposit'],
  ['DEPOSIT_KEY', 'Key deposit (module 13)', 'Key deposit'],
  ['DEPOSIT_OTHER', 'Other refundable deposit (module 13)', 'Other refundable deposit'],
];

async function rename(qi, from, to) {
  for (const [key, a, b] of RENAMES) {
    await qi.sequelize.query('UPDATE charge_heads SET name = :to WHERE `key` = :key AND name = :from', {
      replacements: { key, from: from === 'old' ? a : b, to: to === 'old' ? a : b },
    });
  }
}

module.exports = {
  async up(qi) {
    await rename(qi, 'old', 'new');
  },
  async down(qi) {
    await rename(qi, 'new', 'old');
  },
};
