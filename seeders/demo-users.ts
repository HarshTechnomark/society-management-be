import { createHash } from 'node:crypto';
import { sequelize, User } from '../src/models';
import { now } from '../src/lib/clock';
import { systemCtx } from '../src/types/context';
import { base32Encode, encryptSecret, hashPassword } from '../src/modules/auth/auth.crypto';
import { generateRecoveryCodes } from '../src/modules/auth/auth.mfa';
import { issueAccountSetupToken } from '../src/modules/auth/auth.password.service';

/** Demo accounts of module 02 section 7.10. Memberships and platform roles are seeded by module 03. */
export const DEMO_PASSWORD = 'Demo@Society2026';

interface Demo {
  name: string;
  mobile: string;
  email: string;
  invited?: boolean;
}

export const DEMO_USERS: Demo[] = [
  { name: 'Platform Admin', mobile: '9000000001', email: 'super@societyapp.in' },
  { name: 'Support Agent', mobile: '9000000002', email: 'support@societyapp.in' },
  { name: 'Isha Kapoor', mobile: '9000000003', email: 'isha.kapoor@societyapp.in' },
  { name: 'Dev Malhotra', mobile: '9000000004', email: 'dev.malhotra@societyapp.in', invited: true },
  { name: 'Rajesh Kulkarni', mobile: '9820011111', email: 'chairman@skyheights.in' },
  { name: 'Meera Iyer', mobile: '9820022222', email: 'treasurer@skyheights.in' },
  { name: 'Arjun Shah', mobile: '9820033333', email: 'secretary@skyheights.in' },
  { name: 'Sunil Patil', mobile: '9820044444', email: 'facility@skyheights.in' },
  { name: 'Neha Joshi', mobile: '9820055555', email: 'office@skyheights.in' },
  { name: 'Suresh Pillai', mobile: '9820066666', email: 'suresh@greenpark.in' },
  { name: 'Ritu Agarwal', mobile: '9820077777', email: 'ritu@greenpark.in' },
  { name: 'Kavita Rao', mobile: '9820088888', email: 'admin@tulipgardens.in', invited: true },
];

/** Fixed per account, so testers can add it to an authenticator once. */
export const demoTotpSecret = (email: string): string =>
  base32Encode(createHash('sha256').update(`societyapp-demo-totp:${email}`).digest().subarray(0, 20));

export interface DemoReport {
  created: string[];
  skipped: string[];
  totp: Record<string, string>;
  setupLinks: Record<string, string>;
}

/** Non-production only. Idempotent: an existing mobile or email is skipped. */
export async function seedDemoUsers(): Promise<DemoReport> {
  if (process.env.NODE_ENV === 'production') throw new Error('demo-users must not run in production');
  const hash = await hashPassword(DEMO_PASSWORD);
  const report: DemoReport = { created: [], skipped: [], totp: {}, setupLinks: {} };
  for (const d of DEMO_USERS) {
    const exists = await User.findOne({ where: { email: d.email } });
    if ((exists ?? (await User.findOne({ where: { mobile: d.mobile } }))) !== null) {
      report.skipped.push(d.email);
      continue;
    }
    await sequelize.transaction(async tx => {
      const t = now();
      if (d.invited) {
        const u = await User.create(
          { mobile: d.mobile, email: d.email, name: d.name, status: 'INVITED' } as never,
          { transaction: tx },
        );
        const link = await issueAccountSetupToken(systemCtx('seed'), u.id!, {}, tx);
        report.setupLinks[d.email] = link.rawToken;
      } else {
        const secret = demoTotpSecret(d.email);
        const u = await User.create(
          {
            mobile: d.mobile,
            mobileVerifiedAt: t,
            email: d.email,
            emailVerifiedAt: t,
            name: d.name,
            status: 'ACTIVE',
            passwordHash: hash,
            passwordChangedAt: t,
            totpSecretEnc: encryptSecret(secret),
            mfaEnabledAt: t,
          } as never,
          { transaction: tx },
        );
        await generateRecoveryCodes(u.id!, tx);
        report.totp[d.email] = secret;
      }
      report.created.push(d.email);
    });
  }
  return report;
}
