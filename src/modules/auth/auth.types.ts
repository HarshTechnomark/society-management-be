import type { Amr, ClientApp } from '../../models/session.model';

export type { Amr, ClientApp };

export const OTP_TTL_MS = 5 * 60_000;
export const OTP_RESEND_AFTER_MS = 30_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_RESENDS = 3;
export const MIN_RESPONSE_MS = 400;
export const ACCESS_TTL_SECONDS = 900;
export const REFRESH_GRACE_MS = 10_000;
export const DEVICE_COOKIE_MAX_AGE = 34_560_000;
export const DELETION_GRACE_DAYS = 30;
export const MAX_PASSKEYS = 10;

/** Per-app first factors (module 02 section 1, BR-02-43). */
export const APP_RULES: Record<
  ClientApp,
  { otp: boolean; password: boolean; passkey: boolean; idleMinutes: number; absoluteHours: number }
> = {
  PLATFORM: { otp: false, password: true, passkey: true, idleMinutes: 30, absoluteHours: 12 },
  ADMIN: { otp: true, password: true, passkey: true, idleMinutes: 30, absoluteHours: 12 },
  RESIDENT: { otp: true, password: false, passkey: true, idleMinutes: 10080, absoluteHours: 90 * 24 },
  GATE: { otp: true, password: false, passkey: false, idleMinutes: 840, absoluteHours: 14 },
  WORK: { otp: true, password: false, passkey: true, idleMinutes: 10080, absoluteHours: 30 * 24 },
};

export interface MembershipView {
  societyId: number;
  societyName: string;
  city: string | null;
  societyStatus: string;
  /** `null` for a pending invitation (BR-03-30). */
  memberId: number | null;
  invitationId?: number;
  roleKey: string;
  roleName: string;
  roleScope: 'society' | 'gate' | 'work' | 'platform' | 'resident';
  status: string;
}

export interface AuthUserView {
  id: number;
  name: string | null;
  mobile: string | null;
  email: string | null;
  emailVerified: boolean;
  photoFileId: number | null;
  locale: string;
  status: string;
  hasPassword: boolean;
  mfaEnabled: boolean;
  mfaMandatory: boolean;
  passkeyCount: number;
  recoveryCodesRemaining: number;
  needsProfile: boolean;
  deletionScheduledFor: string | null;
  version: number;
}

/** Response of `GET /auth/me` (section 8.13) and the `me` of every SIGNED_IN result. */
export interface AuthMe {
  user: AuthUserView;
  session: {
    id: number;
    clientApp: ClientApp;
    authTime: string;
    idleTimeoutMinutes: number;
    stepUpMinutes: number;
    absoluteExpiresAt: string;
    amr: Amr[];
  };
  memberships: MembershipView[];
  activeSocietyId: number | null;
  needsSocietyPick: boolean;
  platformRole: { id: number } | null;
  permissions: string[];
  platformPermissions: string[];
  features: string[];
  supportGrant: { id: number; scope: string; endsAt: string } | null;
}

export type SignInResult =
  | { status: 'SIGNED_IN'; me: AuthMe; recoveryCodes?: string[] }
  | {
      status: 'MFA_REQUIRED' | 'MFA_ENROLL_REQUIRED';
      challengeToken: string;
      methods: string[];
      expiresAt: string;
    };

export const mask = (mobile: string): string => `${mobile.slice(0, 2)}XXXXX${mobile.slice(-3)}`;
