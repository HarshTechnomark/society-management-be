import { randomUUID } from 'node:crypto';
import { ApprovalRequest, Collection, CollectionRequest } from '../../src/models';
import { drainQueues } from '../../src/lib/queue';
import { approve, reject, requestChanges } from './approvals-decide';
import { ctxFor } from './billing-invoices';
import { resetPayments } from './payments';
import { runSociety, type RunSociety } from './billing-runs';
import { residentUser } from './residents';

export { resetPayments };
export const idemH = () => ({ 'Idempotency-Key': randomUUID() });

/** A society with `flats` flats: the first `owned` have an owner with a resident login, the rest are vacant. */
export async function collWorld(flats = 4, owned = 3) {
  const w = await runSociety({ flats });
  const owners = [] as Awaited<ReturnType<typeof residentUser>>[];
  for (let i = 0; i < owned; i++)
    owners.push(await residentUser(w.society, w.units[i]!.id, { name: `Owner ${w.units[i]!.label}` }));
  return { w, owners };
}
export type CollWorld = Awaited<ReturnType<typeof collWorld>>;

export const draftBody = (o: Record<string, unknown> = {}) => ({
  title: 'Ganesh Utsav 2026',
  kind: 'FESTIVAL',
  purpose: 'Annual Ganesh celebration contributions',
  amountMode: 'FIXED_PER_UNIT',
  amountPerUnitPaise: 50_000,
  isMandatory: false,
  audienceType: 'ALL',
  dueDate: '2026-12-10',
  fundId: 1,
  ...o,
});

export async function create(w: RunSociety, o: Record<string, unknown> = {}) {
  const r = await w.c('post', '/collections', draftBody(o), { headers: idemH() });
  if (r.status !== 201) throw new Error(`create ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as { id: number; version: number } & Record<string, any>;
}

/** The latest module 14 approval request of the collection (`id` as a number). */
export const approvalOf = async (collectionId: number) => {
  const r = (await ApprovalRequest.findOne({
    where: { entityId: collectionId, type: 'COLLECTION_PUBLISH' },
    order: [['id', 'DESC']],
  }))!;
  return { id: Number(r.id), status: r.status, version: Number(r.version) };
};

/** Create, submit and approve (by the secretary, a different person). Returns the approved detail. */
export async function approved(w: RunSociety, o: Record<string, unknown> = {}) {
  const c = await create(w, o);
  const s = await w.c('post', `/collections/${c.id}/submit`, { version: c.version });
  if (s.status !== 200) throw new Error(`submit ${s.status} ${JSON.stringify(s.body)}`);
  await approve((await approvalOf(c.id)).id, ctxFor(w, w.secretary.user.id!));
  return (await w.c('get', `/collections/${c.id}`)).body.data as Record<string, any>;
}

export async function published(w: RunSociety, o: Record<string, unknown> = {}) {
  const a = await approved(w, o);
  const r = await w.c('post', `/collections/${a.id}/publish`, { version: a.version });
  if (r.status !== 200) throw new Error(`publish ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as Record<string, any>;
}

export const requestsOf = (collectionId: number) =>
  CollectionRequest.findAll({ where: { collectionId }, order: [['id', 'ASC']] });
export const reload = (id: number) => Collection.findByPk(id);
export const settleJobs = () => drainQueues();
export { approve, reject, requestChanges };
