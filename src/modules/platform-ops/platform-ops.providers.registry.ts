import { Op } from 'sequelize';
import { ServiceProvider } from '../../models';
import type { ProviderChannel } from '../../models/service-provider.model';
import { env } from '../../lib/env';
import { nowMs } from '../../lib/clock';
import { decryptCredentials, keyUnavailable } from './platform-ops.crypto';
import { providerEvents } from './platform-ops.shared';

/**
 * Provider resolution for module 16 and module 06 (BR-07-25, section 8.13) and the in-process cache of decrypted
 * credentials (BR-07-21: at most 60 seconds, cleared on `platform-ops:providers-changed`). Credentials are never put in
 * Redis, logs, job payloads or responses.
 */
export interface ResolvedProvider {
  providerId: number | null;
  providerKey: string;
  vendor: string;
  config: Record<string, unknown>;
  credentials: Record<string, string> | null;
  source: 'DATABASE' | 'ENV' | 'FAKE';
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; creds: Record<string, string> }>();
providerEvents.on('platform-ops:providers-changed', () => cache.clear());

/** Decrypted credentials of a row loaded with the `withSecrets` scope; `null` for an ENV-sourced vendor. */
export function credentialsOf(p: ServiceProvider): Record<string, string> | null {
  if (p.credentialsSource === 'ENV') return null;
  if (!p.credentialsEnc || !p.credentialsIv || !p.credentialsTag || p.credentialsKeyVersion === null)
    return null;
  const key = `${p.id}:${p.credentialsKeyVersion}:${p.credentialsUpdatedAt?.getTime() ?? 0}`;
  const hit = cache.get(key);
  if (hit && nowMs() - hit.at < CACHE_MS) return hit.creds;
  if (!p.credentialsIv) throw keyUnavailable();
  const creds = decryptCredentials(p.providerKey, {
    enc: p.credentialsEnc,
    iv: p.credentialsIv,
    tag: p.credentialsTag,
    keyVersion: p.credentialsKeyVersion,
  });
  cache.set(key, { at: nowMs(), creds });
  return creds;
}

export const clearCredentialCache = (): void => cache.clear();

const sourceOf = (p: ServiceProvider): ResolvedProvider['source'] =>
  p.vendor === 'FAKE' ? 'FAKE' : p.credentialsSource;

const toResolved = (p: ServiceProvider): ResolvedProvider => ({
  providerId: p.id!,
  providerKey: p.providerKey,
  vendor: p.vendor,
  config: p.configJson,
  credentials: credentialsOf(p),
  source: sourceOf(p),
});

const FAKE: ResolvedProvider = {
  providerId: null,
  providerKey: 'fake',
  vendor: 'FAKE',
  config: { failMode: 'none' },
  credentials: null,
  source: 'FAKE',
};
const ENV_FALLBACK: ResolvedProvider = {
  providerId: null,
  providerKey: 'env',
  vendor: 'ENV',
  config: {},
  credentials: null,
  source: 'ENV',
};

async function enabledRows(channel: ProviderChannel): Promise<ServiceProvider[]> {
  return ServiceProvider.scope('withSecrets').findAll({
    where: { channel, isEnabled: true, priority: { [Op.ne]: null } },
    order: [['priority', 'ASC']],
  });
}

/** Enabled providers in fallback order: healthy ones by priority first, then those in OUTAGE. */
export async function listEnabledProviders(
  channel: ProviderChannel,
  mode: 'real' | 'fake' = env().PROVIDERS_MODE,
): Promise<ResolvedProvider[]> {
  if (mode === 'fake') return [FAKE];
  const rows = await enabledRows(channel);
  const ok = rows.filter(r => r.healthStatus !== 'OUTAGE');
  const out = rows.filter(r => r.healthStatus === 'OUTAGE');
  return [...ok, ...out].map(toResolved);
}

/**
 * BR-07-25: the enabled provider with the lowest priority whose health is not OUTAGE; if all are in OUTAGE the primary
 * anyway; with none enabled the environment-configured adapter; `PROVIDERS_MODE=fake` always answers the fake.
 */
export async function resolveProvider(
  channel: ProviderChannel,
  mode: 'real' | 'fake' = env().PROVIDERS_MODE,
): Promise<ResolvedProvider> {
  if (mode === 'fake') return FAKE;
  const rows = await enabledRows(channel);
  if (!rows.length) return ENV_FALLBACK;
  return toResolved(rows.find(r => r.healthStatus !== 'OUTAGE') ?? rows[0]!);
}
