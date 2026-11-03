import { AppError, UnprocessableError } from '../../utils/errors';
import { floorLabel, type FloorLabels } from './society-setup.shared';

/**
 * Numbering pattern of the bulk unit generator (module 08 BR-08-31). Pure functions: no database, no clock.
 * Literals are `A-Z 0-9 - /`; tokens are `{building}`, `{floor}`, `{floor:N}`, `{pos}`, `{pos:N}`, `{posAlpha}`,
 * `{seq}` and `{seq:N}` with N from 1 to 4 (zero padding).
 */
export type Token =
  | { kind: 'lit'; text: string }
  | { kind: 'building' }
  | { kind: 'floor'; pad: number }
  | { kind: 'pos'; pad: number }
  | { kind: 'posAlpha' }
  | { kind: 'seq'; pad: number };

export const UNIT_NUMBER_RE = /^[A-Z0-9][A-Z0-9/-]{0,19}$/;
const TOKEN_RE = /^\{(building|floor|pos|posAlpha|seq)(?::([1-4]))?\}/;
const LITERAL_RE = /^[A-Z0-9/-]/;

const invalid = (message: string) => new AppError(400, 'PATTERN_INVALID', message);

export function parsePattern(pattern: string): Token[] {
  if (pattern.length < 1 || pattern.length > 40) throw invalid('The pattern must be 1 to 40 characters');
  const tokens: Token[] = [];
  let rest = pattern;
  while (rest.length) {
    if (rest[0] === '{') {
      const m = TOKEN_RE.exec(rest);
      if (!m) throw invalid(`Unknown token near "${rest.slice(0, 12)}"`);
      const name = m[1]!;
      const pad = m[2] ? Number(m[2]) : 0;
      if ((name === 'building' || name === 'posAlpha') && m[2]) throw invalid(`{${name}} takes no number`);
      if (name === 'building') tokens.push({ kind: 'building' });
      else if (name === 'posAlpha') tokens.push({ kind: 'posAlpha' });
      else tokens.push({ kind: name as 'floor' | 'pos' | 'seq', pad });
      rest = rest.slice(m[0].length);
    } else if (LITERAL_RE.test(rest)) {
      const last = tokens[tokens.length - 1];
      if (last?.kind === 'lit') last.text += rest[0];
      else tokens.push({ kind: 'lit', text: rest[0]! });
      rest = rest.slice(1);
    } else throw invalid(`The character "${rest[0]}" is not allowed in a pattern`);
  }
  return tokens;
}

/** BR-08-31: a floor token with a position token, or a sequence token. */
export function assertPatternUnique(tokens: Token[]): void {
  const has = (k: Token['kind']) => tokens.some(t => t.kind === k);
  if (has('seq') || (has('floor') && (has('pos') || has('posAlpha')))) return;
  throw new UnprocessableError(
    'PATTERN_NOT_UNIQUE',
    'The pattern must contain a floor and a position, or a running number',
  );
}

export interface RenderInput {
  building: string;
  floor: number;
  position: number;
  seq: number;
  labels: FloorLabels;
}

const pad = (n: number, width: number): string => (width ? String(n).padStart(width, '0') : String(n));

/** The unit number of one cell; throws `400 PATTERN_INVALID` naming the first number that breaks BR-08-19. */
export function renderNumber(tokens: Token[], i: RenderInput): string {
  let out = '';
  for (const t of tokens) {
    switch (t.kind) {
      case 'lit':
        out += t.text;
        break;
      case 'building':
        out += i.building;
        break;
      case 'floor':
        out += i.floor > 0 ? pad(i.floor, t.pad) : floorLabel(i.floor, i.labels);
        break;
      case 'pos':
        out += pad(i.position, t.pad);
        break;
      case 'posAlpha':
        if (i.position > 26) throw invalid('{posAlpha} needs 26 positions or fewer');
        out += String.fromCharCode(64 + i.position);
        break;
      case 'seq':
        out += pad(i.seq, t.pad);
        break;
    }
  }
  if (!UNIT_NUMBER_RE.test(out)) throw invalid(`The pattern gives an invalid unit number: "${out}"`);
  return out;
}
