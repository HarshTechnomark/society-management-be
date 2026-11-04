'use strict';
/**
 * Module 11 section 7: three CHECKs of the first migrations let a NULL slip through (`NULL BETWEEN ...` is NULL, which a
 * CHECK accepts) and the charge head key regexp was case-insensitive under the ai_ci collation. They now require NOT NULL
 * explicitly and compare the key as BINARY. `down` restores the earlier, weaker definitions.
 */
const CHANGES = [
  [
    'charge_heads',
    'ck_charge_heads_key',
    "`key` COLLATE utf8mb4_0900_as_cs REGEXP '^[A-Z][A-Z0-9_]{1,39}$'",
    "`key` REGEXP '^[A-Z][A-Z0-9_]{1,39}$'",
  ],
  [
    'bill_split_rules',
    'ck_split_rules_fixed',
    "(amountSource = 'FIXED' AND fixedAmountPaise IS NOT NULL AND fixedAmountPaise BETWEEN 1 AND 1000000000) OR (amountSource = 'RUN_INPUT' AND fixedAmountPaise IS NULL)",
    "(amountSource = 'FIXED' AND fixedAmountPaise BETWEEN 1 AND 1000000000) OR (amountSource = 'RUN_INPUT' AND fixedAmountPaise IS NULL)",
  ],
  [
    'late_fee_policies',
    'ck_late_fee_interest',
    "policyType <> 'SIMPLE_INTEREST' OR (interestRatePct IS NOT NULL AND interestRatePct BETWEEN 0.0001 AND 21.0000 AND interestFrom IS NOT NULL AND interestFrom IN ('DUE_DATE','GRACE_END') AND flatFeePaise IS NULL)",
    "policyType <> 'SIMPLE_INTEREST' OR (interestRatePct BETWEEN 0.0001 AND 21.0000 AND interestFrom IN ('DUE_DATE','GRACE_END') AND flatFeePaise IS NULL)",
  ],
  [
    'late_fee_policies',
    'ck_late_fee_flat',
    "policyType <> 'FLAT' OR (flatFeePaise IS NOT NULL AND flatFeePaise BETWEEN 100 AND 1000000 AND interestRatePct IS NULL AND interestFrom IS NULL)",
    "policyType <> 'FLAT' OR (flatFeePaise BETWEEN 100 AND 1000000 AND interestRatePct IS NULL AND interestFrom IS NULL)",
  ],
];

module.exports = {
  async up(qi) {
    for (const [table, name, next] of CHANGES) {
      await qi.sequelize.query(`ALTER TABLE ${table} DROP CHECK ${name}`);
      await qi.sequelize.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${next})`);
    }
  },
  async down(qi) {
    for (const [table, name, , previous] of CHANGES) {
      await qi.sequelize.query(`ALTER TABLE ${table} DROP CHECK ${name}`);
      await qi.sequelize.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${previous})`);
    }
  },
};
