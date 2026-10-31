import 'dotenv/config';
import { closeDb, sequelize } from '../src/models';
import { seedSystemUser } from '../seeders/system-user';
import { seedDemoUsers, DEMO_PASSWORD } from '../seeders/demo-users';

/** `npm run seed` runs `system-user` everywhere and `demo-users` outside production. */
const out = (s: string) => process.stdout.write(`${s}\n`);

async function main(): Promise<void> {
  await sequelize.authenticate();
  const sys = await seedSystemUser();
  out(`system-user: ${sys.created ? 'created' : 'already exists'} (id ${sys.id})`);
  if (process.env.NODE_ENV === 'production') {
    out('demo-users: skipped in production');
  } else {
    const r = await seedDemoUsers();
    out(
      `demo-users: created ${r.created.length}, skipped ${r.skipped.length}. Password for all: ${DEMO_PASSWORD}`,
    );
    for (const [email, secret] of Object.entries(r.totp)) out(`  TOTP ${email}: ${secret}`);
    for (const [email, token] of Object.entries(r.setupLinks))
      out(`  setup link ${email}: /setup?token=${token}`);
  }
  await closeDb();
}

main().catch(err => {
  process.stderr.write(`${String(err?.stack ?? err)}\n`);
  process.exit(1);
});
