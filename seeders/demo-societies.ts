import { Society } from '../src/models';
import { addDays, now } from '../src/lib/clock';

/**
 * Module 01 `demo-societies`: only the society rows (module 08 adds towers and flats, module 05 the lifecycle columns).
 * Idempotent by slug. Not run in production.
 */
export interface DemoSociety {
  slug: string;
  name: string;
  city: string;
  state: string;
  pincode: string;
  addressLine1: string;
  status: 'ACTIVE' | 'TRIAL';
  note: string;
}

export const DEMO_SOCIETIES: DemoSociety[] = [
  {
    slug: 'sky-heights',
    name: 'Sky Heights CHS',
    city: 'Pune',
    state: 'Maharashtra',
    pincode: '411045',
    addressLine1: 'Survey 42, Baner Road',
    status: 'ACTIVE',
    note: '3 towers, 72 flats',
  },
  {
    slug: 'green-park',
    name: 'Green Park CHS',
    city: 'Thane',
    state: 'Maharashtra',
    pincode: '400601',
    addressLine1: 'Ghodbunder Road, Majiwada',
    status: 'ACTIVE',
    note: '2 towers, 30 flats',
  },
  {
    slug: 'tulip-gardens',
    name: 'Tulip Gardens CHS',
    city: 'Bhopal',
    state: 'Madhya Pradesh',
    pincode: '462026',
    addressLine1: 'Plot 14, Hoshangabad Road',
    status: 'TRIAL',
    note: 'empty, onboarding not started',
  },
];

export async function seedDemoSocieties(): Promise<{ created: string[]; skipped: string[] }> {
  if (process.env.NODE_ENV === 'production') throw new Error('demo-societies must not run in production');
  const created: string[] = [];
  const skipped: string[] = [];
  for (const d of DEMO_SOCIETIES) {
    const exists = await Society.findOne({ where: { slug: d.slug } });
    if (exists) {
      skipped.push(d.slug);
      continue;
    }
    await Society.create({
      slug: d.slug,
      name: d.name,
      city: d.city,
      state: d.state,
      pincode: d.pincode,
      addressLine1: d.addressLine1,
      status: d.status,
      // module 05 CHECK constraints: a TRIAL society has a trial end (the module 05 seed sets the demo values)
      trialEndsAt: d.status === 'TRIAL' ? addDays(now(), 14) : null,
      activatedAt: d.status === 'ACTIVE' ? now() : null,
    } as never);
    created.push(d.slug);
  }
  return { created, skipped };
}
