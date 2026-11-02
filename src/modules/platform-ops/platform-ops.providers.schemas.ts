import { z } from 'zod';
import type { ProviderChannel, ProviderVendor } from '../../models/service-provider.model';

/** Vendor matrix, config and credentials schemas of module 07 section 7.4 (Zod, strict; credentials are always complete). */
const senderId = z.string().regex(/^[A-Z]{6}$/);
const dlt = z.string().regex(/^\d{12,20}$/);
const printable = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[\x21-\x7e]+$/, 'Printable characters only');
const email = z.string().email().max(254);

const smsConfig = z.object({ senderId, dltEntityId: dlt, testTemplateId: dlt }).strict();

interface VendorSpec {
  channels: ProviderChannel[];
  config: Partial<Record<ProviderChannel | '*', z.ZodType<Record<string, unknown>>>>;
  /** Credentials by channel (or `*`); `null` = none (credentials come from the environment). */
  credentials: Partial<Record<ProviderChannel | '*', z.ZodType<Record<string, string>> | null>>;
  source: 'DATABASE' | 'ENV';
}

export const VENDORS: Record<ProviderVendor, VendorSpec> = {
  MSG91: {
    channels: ['SMS'],
    config: { SMS: smsConfig },
    credentials: { SMS: z.object({ authKey: printable(20, 64) }).strict() },
    source: 'DATABASE',
  },
  GUPSHUP: {
    channels: ['SMS', 'WHATSAPP'],
    config: {
      SMS: smsConfig,
      WHATSAPP: z
        .object({ sourceNumber: z.string().regex(/^91[6-9]\d{9}$/), appName: z.string().min(3).max(50) })
        .strict(),
    },
    credentials: {
      SMS: z.object({ userId: z.string().regex(/^\d{6,12}$/), password: printable(8, 64) }).strict(),
      WHATSAPP: z.object({ apiKey: printable(20, 64) }).strict(),
    },
    source: 'DATABASE',
  },
  KALEYRA: {
    channels: ['SMS'],
    config: {
      SMS: z
        .object({ sid: z.string().min(6).max(40), senderId, dltEntityId: dlt, testTemplateId: dlt })
        .strict(),
    },
    credentials: { SMS: z.object({ apiKey: printable(20, 64) }).strict() },
    source: 'DATABASE',
  },
  META_CLOUD: {
    channels: ['WHATSAPP'],
    config: {
      WHATSAPP: z
        .object({
          phoneNumberId: z.string().regex(/^\d{10,20}$/),
          wabaId: z.string().regex(/^\d{10,20}$/),
          apiVersion: z.string().regex(/^v\d{2}\.\d$/),
          testTemplate: z
            .string()
            .min(1)
            .max(60)
            .regex(/^[a-z0-9_]+$/),
        })
        .strict(),
    },
    credentials: {
      WHATSAPP: z
        .object({ accessToken: printable(50, 512), appSecret: z.string().regex(/^[a-f0-9]{32}$/) })
        .strict(),
    },
    source: 'DATABASE',
  },
  AWS_SES: {
    channels: ['EMAIL'],
    config: {
      EMAIL: z
        .object({
          region: z.enum(['ap-south-1', 'ap-south-2']),
          fromEmail: email,
          fromName: z.string().min(2).max(60),
          configurationSet: z.string().max(64).optional(),
        })
        .strict(),
    },
    credentials: {
      EMAIL: z
        .object({
          accessKeyId: z.string().regex(/^AKIA[0-9A-Z]{16}$/),
          secretAccessKey: z.string().regex(/^[A-Za-z0-9/+]{40}$/),
        })
        .strict(),
    },
    source: 'DATABASE',
  },
  SENDGRID: {
    channels: ['EMAIL'],
    config: { EMAIL: z.object({ fromEmail: email, fromName: z.string().min(2).max(60) }).strict() },
    credentials: {
      EMAIL: z.object({ apiKey: z.string().regex(/^SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/) }).strict(),
    },
    source: 'DATABASE',
  },
  WEB_PUSH_VAPID: {
    channels: ['PUSH'],
    config: { PUSH: z.object({ subject: z.string().regex(/^mailto:.+@.+$/) }).strict() },
    credentials: {
      PUSH: z
        .object({
          publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
          privateKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        })
        .strict(),
    },
    source: 'DATABASE',
  },
  RAZORPAY: {
    channels: ['PAYMENT_GATEWAY'],
    config: { PAYMENT_GATEWAY: z.object({ mode: z.enum(['test', 'live']) }).strict() },
    credentials: {
      PAYMENT_GATEWAY: z
        .object({
          keyId: z.string().regex(/^rzp_(test|live)_[A-Za-z0-9]{14}$/),
          keySecret: z.string().min(20).max(40),
          webhookSecret: z.string().min(12).max(100),
        })
        .strict(),
    },
    source: 'DATABASE',
  },
  CASHFREE: {
    channels: ['PAYMENT_GATEWAY'],
    config: { PAYMENT_GATEWAY: z.object({ mode: z.enum(['sandbox', 'production']) }).strict() },
    credentials: {
      PAYMENT_GATEWAY: z
        .object({ appId: z.string().min(10).max(60), secretKey: z.string().min(20).max(100) })
        .strict(),
    },
    source: 'DATABASE',
  },
  S3_COMPATIBLE: {
    channels: ['STORAGE'],
    config: { STORAGE: z.object({}).strict() },
    credentials: { '*': null },
    source: 'ENV',
  },
  EXOTEL: {
    channels: ['IVR'],
    config: {
      IVR: z
        .object({
          sid: z.string().min(3).max(60),
          subdomain: z.enum(['api.exotel.com', 'api.in.exotel.com']),
          callerId: z.string().regex(/^0\d{10}$/),
        })
        .strict(),
    },
    credentials: {
      IVR: z.object({ apiKey: printable(20, 64), apiToken: printable(20, 64) }).strict(),
    },
    source: 'DATABASE',
  },
  FAKE: {
    channels: [...(['SMS', 'WHATSAPP', 'EMAIL', 'PUSH', 'PAYMENT_GATEWAY', 'STORAGE', 'IVR'] as const)],
    config: { '*': z.object({ failMode: z.enum(['none', 'error', 'slow']) }).strict() },
    credentials: { '*': null },
    source: 'ENV',
  },
};

export const vendorAllowedFor = (vendor: ProviderVendor, channel: ProviderChannel): boolean =>
  VENDORS[vendor].channels.includes(channel);

export const configSchema = (vendor: ProviderVendor, channel: ProviderChannel) =>
  (VENDORS[vendor].config[channel] ?? VENDORS[vendor].config['*'])!;

/** `null` when the vendor takes no credentials (environment-sourced). */
export const credentialsSchema = (vendor: ProviderVendor, channel: ProviderChannel) => {
  const spec = VENDORS[vendor].credentials;
  const s = channel in spec ? spec[channel] : spec['*'];
  return s ?? null;
};

export const credentialsSource = (vendor: ProviderVendor): 'DATABASE' | 'ENV' => VENDORS[vendor].source;
