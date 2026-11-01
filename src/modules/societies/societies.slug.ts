/** Slug and name rules (BR-05-6, BR-05-7). Pure functions. */

export const RESERVED_SLUGS = [
  'www',
  'api',
  'admin',
  'app',
  'my',
  'gate',
  'work',
  'platform',
  'support',
  'status',
  'mail',
  'help',
  'docs',
  'static',
  'cdn',
  'societyapp',
] as const;
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Lowercase, non-alphanumerics → `-`, trimmed to 60 characters. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export const isReservedSlug = (slug: string): boolean => (RESERVED_SLUGS as readonly string[]).includes(slug);
export const isValidSlug = (slug: string): boolean =>
  slug.length >= 3 && slug.length <= 60 && SLUG_PATTERN.test(slug);

/** `slug-2` … keeps the result within 60 characters. */
export function withSuffix(slug: string, n: number): string {
  const suffix = `-${n}`;
  return `${slug.slice(0, 60 - suffix.length).replace(/-+$/g, '')}${suffix}`;
}

const DROP_WORDS = new Set(['chs', 'coop', 'cooperative', 'housing', 'society', 'ltd', 'limited', 'hsg']);

/** BR-05-7: lowercase; drop `chs`, `co-op`, `co-operative`, `cooperative`, `housing`, `society`, `ltd`, `limited`, `hsg`, punctuation and spaces. */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/co-operative|co-op/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(w => w && !DROP_WORDS.has(w))
    .join('');
}

/** Candidate suggestions for a taken slug, in preference order. */
export function slugCandidates(slug: string, city?: string | null): string[] {
  const out: string[] = [];
  const citySlug = city ? slugify(city) : '';
  if (citySlug && !slug.endsWith(`-${citySlug}`))
    out.push(`${slug}-${citySlug}`.slice(0, 60).replace(/-+$/g, ''));
  for (let i = 2; i <= 20; i++) out.push(withSuffix(slug, i));
  const words = slug.split('-');
  if (words.length > 1) out.push(`${words[0]}-${words[1]!.slice(0, 3)}-chs`);
  return out.filter(isValidSlug).filter(s => !isReservedSlug(s));
}
