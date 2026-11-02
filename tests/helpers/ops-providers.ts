import { ServiceProvider } from '../../src/models';

type Call = (
  method: 'get' | 'post' | 'patch' | 'put' | 'delete',
  path: string,
  body?: unknown,
  o?: any,
) => any;

/** Creates a FAKE provider through the API (disabled), optionally enabling it. */
export async function fakeProvider(
  c: Call,
  o: {
    key?: string;
    channel?: string;
    priority?: number;
    failMode?: 'none' | 'error' | 'slow';
    enable?: boolean;
    name?: string;
  } = {},
): Promise<ServiceProvider> {
  const r = await c(
    'post',
    '/platform/providers',
    {
      providerKey: o.key ?? 'sms_test',
      channel: o.channel ?? 'SMS',
      vendor: 'FAKE',
      displayName: o.name ?? 'SMS gateway (test)',
      priority: o.priority ?? 1,
      config: { failMode: o.failMode ?? 'none' },
    },
    { headers: { 'Idempotency-Key': crypto.randomUUID() } },
  );
  if (r.status !== 201) throw new Error(`provider create failed: ${JSON.stringify(r.body)}`);
  let p = (await ServiceProvider.findByPk(r.body.data.id))!;
  if (o.enable !== false) {
    const e = await c('patch', `/platform/providers/${p.id}`, { version: p.version, isEnabled: true });
    if (e.status !== 200) throw new Error(`provider enable failed: ${JSON.stringify(e.body)}`);
    p = (await ServiceProvider.findByPk(p.id!))!;
  }
  return p;
}

export const MSG91_CREDS = { authKey: 'abcdefghij0123456789klmnopqr3f9a' };
export const MSG91_CONFIG = {
  senderId: 'SOCAPP',
  dltEntityId: '1201160000000012345',
  testTemplateId: '1207160000000067890',
};
