import { randomBytes } from 'node:crypto';
import { now } from './clock';
import { kv } from './kv';

/** Messages recorded by the fake adapters, read by `GET /api/v1/dev/inbox` (module 01 section 8.9). */
export interface InboxMessage {
  id: string;
  channel: 'SMS' | 'WHATSAPP' | 'EMAIL' | 'PUSH';
  to: string;
  subject: string | null;
  body: string;
  link: string | null;
  templateKey: string | null;
  createdAt: string;
}

const KEY = 'dev:inbox';
const MAX = 200;

export async function recordInbox(
  m: Omit<InboxMessage, 'id' | 'createdAt' | 'link'> & { link?: string | null },
) {
  const link = m.link ?? m.body.match(/https?:\/\/\S+/)?.[0] ?? null;
  const full: InboxMessage = {
    ...m,
    link,
    id: randomBytes(6).toString('hex'),
    createdAt: now().toISOString(),
  };
  await kv().listPush(KEY, JSON.stringify(full), MAX);
  return full;
}

/** Newest first. */
export async function listInbox(): Promise<InboxMessage[]> {
  return (await kv().listAll(KEY)).map(s => JSON.parse(s) as InboxMessage);
}

export async function clearInbox(): Promise<void> {
  await kv().listClear(KEY);
}
