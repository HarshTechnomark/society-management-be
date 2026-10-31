import { User } from '../src/models';
import { now } from '../src/lib/clock';

/**
 * Seeder `system-user` (BR-02-58): runs in every environment, including production, exactly once (idempotent by
 * email). The system user owns system-generated files and is the actor of jobs; it can never hold a session.
 */
export async function seedSystemUser(): Promise<{ created: boolean; id: number }> {
  const existing = await User.findOne({ where: { email: 'system@societyapp.in' } });
  if (existing) return { created: false, id: existing.id! };
  const u = await User.create({
    mobile: null,
    email: 'system@societyapp.in',
    emailVerifiedAt: null,
    name: 'System',
    status: 'SYSTEM',
    createdAt: now(),
  } as never);
  return { created: true, id: u.id! };
}
