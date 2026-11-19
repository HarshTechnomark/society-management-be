import { resolveProvider } from '../platform-ops/platform-ops.public';
import type { Channel } from './communication.constants';
import type { ProvidersPort } from './communication.ports';

/** BR-16-28: every attempt asks module 07 `resolveProvider(channel)`; module 16 never picks a provider itself. IN_APP has no provider. */
export const moduleSevenProviders: ProvidersPort = {
  async resolve(channel: Channel) {
    if (channel === 'IN_APP') return { providerKey: 'in-app' };
    const p = await resolveProvider(channel);
    return { providerKey: p.providerKey };
  },
};
