import 'dotenv/config';
import { closeDb, sequelize } from '../src/models';
import { seedSystemUser } from '../seeders/system-user';
import { seedDemoUsers, DEMO_PASSWORD } from '../seeders/demo-users';
import { seedDemoSocieties } from '../seeders/demo-societies';
import { seedAccessControl } from '../seeders/access-control';
import {
  reconcileDemoUsage,
  seedDemoSubscriptions,
  seedSubscriptionCatalogue,
} from '../seeders/subscriptions';
import { registerAccessControl } from '../src/modules/access-control/access-control.public';
import { registerSubscriptions } from '../src/modules/subscriptions/subscriptions.public';
import { registerSocieties } from '../src/modules/societies/societies.public';
import { seedSocieties } from '../seeders/societies';

/** `npm run seed` runs `system-user` and the permission catalogue everywhere; demo users, societies and memberships outside production. */
const out = (s: string) => process.stdout.write(`${s}\n`);

async function main(): Promise<void> {
  await sequelize.authenticate();
  const sys = await seedSystemUser();
  out(`system-user: ${sys.created ? 'created' : 'already exists'} (id ${sys.id})`);
  // module 04: real entitlement ports, so seats and custom roles are counted while members are seeded
  registerAccessControl();
  registerSubscriptions();
  registerSocieties();
  const cat = await seedSubscriptionCatalogue();
  out(
    `subscriptions-catalogue: plans created ${cat.plansCreated}, entitlement rows added ${cat.rowsAdded}, add-ons created ${cat.addonsCreated}`,
  );
  if (process.env.NODE_ENV === 'production') {
    out('demo-users: skipped in production');
    const a = await seedAccessControl({ demo: false });
    out(`access-control: catalogue synced (${a.catalogueAdded} new), roles created ${a.rolesCreated}`);
  } else {
    const r = await seedDemoUsers();
    out(
      `demo-users: created ${r.created.length}, skipped ${r.skipped.length}. Password for all: ${DEMO_PASSWORD}`,
    );
    for (const [email, secret] of Object.entries(r.totp)) out(`  TOTP ${email}: ${secret}`);
    for (const [email, token] of Object.entries(r.setupLinks))
      out(`  setup link ${email}: /setup?token=${token}`);
    const so = await seedDemoSocieties();
    out(`demo-societies: created ${so.created.length}, skipped ${so.skipped.length}`);
    const ds = await seedDemoSubscriptions();
    out(
      `demo-subscriptions: created ${ds.created.join(', ') || 'none'}, skipped ${ds.skipped.length}, flags ${ds.flags}`,
    );
    const a = await seedAccessControl({ demo: true });
    out(
      `access-control: catalogue ${a.catalogueAdded} new keys, roles created ${a.rolesCreated}, platform roles set ${a.platformAssigned.length}, members ${a.members.length}`,
    );
    for (const [name, l] of Object.entries(a.invitations)) {
      out(`  invitation ${name}: ${l.inviteLink}`);
      if (l.setupLink) out(`  setup link ${name}: ${l.setupLink}`);
    }
    const so5 = await seedSocieties();
    out(
      `societies: lifecycle set ${so5.societies.join(', ') || 'none'}, grants ${so5.grants.join(', ') || 'none'}, notes ${so5.notes}`,
    );
    out(`usage-reconcile: ${await reconcileDemoUsage()} counters set`);
  }
  await closeDb();
}

main().catch(err => {
  process.stderr.write(`${String(err?.stack ?? err)}\n`);
  process.exit(1);
});
