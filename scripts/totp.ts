/**
 * Development helper: prints the current 6-digit authenticator code, so you can sign in without a phone.
 *
 *   npm run dev:totp -- chairman@skyheights.in        demo account (secret derived like the seeder does)
 *   npm run dev:totp -- JBSWY3DPEHPK3PXP              any base32 secret shown on the enrolment screen
 *
 * It needs no database and no .env. Never use it against a production account.
 */
import { createHash } from 'node:crypto';
import { base32Encode, TOTP_STEP_SECONDS, totpCode, totpStepAt } from '../src/modules/auth/auth.crypto';

const arg = (process.argv[2] ?? '').trim();
if (!arg) {
  process.stderr.write('Usage: npm run dev:totp -- <demo account email | base32 secret>\n');
  process.exit(1);
}

const isEmail = arg.includes('@');
const secret = isEmail
  ? base32Encode(createHash('sha256').update(`societyapp-demo-totp:${arg}`).digest().subarray(0, 20))
  : arg.replace(/\s+/g, '').toUpperCase();

const nowMs = Date.now();
const left = TOTP_STEP_SECONDS - (Math.floor(nowMs / 1000) % TOTP_STEP_SECONDS);
process.stdout.write(`${totpCode(secret, totpStepAt(nowMs))}  (valid for about ${left} more seconds)\n`);
