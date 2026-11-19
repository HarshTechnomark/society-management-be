import { syncTemplates } from './communication.registry';
import { dropTemplateCache } from './communication.templates';

/** The `templates:sync` seeder (BR-16-50, 10.2). Idempotent; never overwrites edited text. */
export async function seedTemplates(): Promise<{ keys: number; written: number }> {
  const r = await syncTemplates();
  dropTemplateCache();
  return r;
}
