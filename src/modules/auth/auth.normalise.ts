import { z } from 'zod';

/** BR-02-1: strip spaces, hyphens and a leading +91, 91 or 0, then require ten digits starting 6-9. */
export function normaliseMobile(input: string): string {
  let s = input.replace(/[\s-]/g, '');
  if (s.startsWith('+91')) s = s.slice(3);
  else if (s.length === 12 && s.startsWith('91')) s = s.slice(2);
  else if (s.length === 11 && s.startsWith('0')) s = s.slice(1);
  return s;
}

export const MOBILE_RE = /^[6-9]\d{9}$/;
export const mobileSchema = z
  .string()
  .transform(normaliseMobile)
  .pipe(z.string().regex(MOBILE_RE, 'Enter a valid 10-digit mobile number'));

/** BR-02-2: trimmed, lowercased, at most 254 characters. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email is too long')
  .pipe(z.email('Enter a valid email address'));

/** BR-02-6: 2-120 characters, Unicode letters and marks, space, dot, apostrophe, hyphen; inner spaces collapsed. */
export const nameSchema = z
  .string()
  .transform(s => s.trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(2, 'Name must be at least 2 characters')
      .max(120, 'Name must be at most 120 characters')
      .regex(/^[\p{L}\p{M} .'-]+$/u, 'Name has characters that are not allowed'),
  );

export const normaliseEmail = (s: string): string => s.trim().toLowerCase();
