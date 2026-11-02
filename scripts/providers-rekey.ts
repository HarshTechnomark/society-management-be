import 'dotenv/config';
import { closeDb, sequelize } from '../src/models';
import { rekeyProviders } from '../src/modules/platform-ops/platform-ops.providers.rekey';

/** `npm run providers:rekey`: re-encrypts provider credentials with the active key version (module 07 section 9.1). */
const out = (s: string) => process.stdout.write(`${s}\n`);

async function main(): Promise<void> {
  await sequelize.authenticate();
  const r = await rekeyProviders();
  out(
    `providers:rekey: re-encrypted ${r.rekeyed} provider(s); ${r.remainingOnOldVersions} row(s) still on an old key version`,
  );
}

main()
  .catch(err => {
    out(`providers:rekey failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
