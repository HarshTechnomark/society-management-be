/**
 * The only auth functions other modules may import (section 8.30), grouped as `users`, `sessions` and `auth`.
 * Ports other modules implement for module 02 are in `auth.ports.ts`.
 */
import { users } from './auth.users';
import { sessions, countActiveUsers, countActiveUsersPlatform } from './auth.sessions';
import {
  consumeSignupToken,
  issueAccountSetupToken,
  revokeAccountSetupTokens,
} from './auth.password.service';
import { resetMfaForUser } from './auth.reset-mfa';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';

export { users, sessions };
export const auth = {
  consumeSignupToken,
  issueAccountSetupToken,
  revokeAccountSetupTokens,
  resetMfa: resetMfaForUser,
  countActiveUsers,
  countActiveUsersPlatform,
  requireRecentAuth,
};
export { setAuthPorts } from './auth.ports';
export type { AuthPorts } from './auth.ports';
export type { ClientApp, Amr, AuthMe } from './auth.types';
