/**
 * BR-16-2 server-side HTML sanitiser for notice bodies (allow-list, no dependencies). PURE.
 * Allowed tags: p br strong b em i u ul ol li h3 h4 blockquote a (href only when it starts `https://` or `/`, always
 * `rel="noopener noreferrer" target="_blank"`). Everything else is removed; the contents of script, style and similar
 * tags are removed with the tag. `bodyText` is the plain text (SMS summaries, search, read-aloud).
 */
const ALLOWED = new Set([
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'ul',
  'ol',
  'li',
  'h3',
  'h4',
  'blockquote',
  'a',
]);
const VOID = new Set(['br']);
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'template',
  'noscript',
  'textarea',
  'select',
  'svg',
  'math',
  'head',
  'title',
]);
const BLOCK = new Set(['p', 'br', 'ul', 'ol', 'li', 'h3', 'h4', 'blockquote']);

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^<>"'])*)>/g;

const escapeText = (s: string): string =>
  s
    .replace(/&(?!(?:amp|lt|gt|quot|#39|#\d{1,6}|#x[0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Decodes the few entities the sanitiser itself may produce, and numeric ones, for plain text and href checks. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_m, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_m, d: string) => safeChar(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
function safeChar(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
  return String.fromCodePoint(cp);
}

function hrefOf(attrs: string): string | null {
  const m = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  if (!m) return null;
  // eslint-disable-next-line no-control-regex
  const raw = decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').replace(/[\u0000-\u001f\u007f\s]/g, '');
  if (raw.length > 500) return null;
  if (/^https:\/\/[^/\s]/i.test(raw)) return raw;
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\')) return raw;
  return null;
}

export function sanitizeHtml(input: string): string {
  const src = String(input ?? '').replace(/<!--[\s\S]*?-->/g, '');
  let out = '';
  let last = 0;
  let skipUntil: string | null = null; // dropping the content of this tag
  const open: string[] = [];
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(src); m; m = TAG_RE.exec(src)) {
    const [whole, slash, rawName, attrs] = m as unknown as [string, string, string, string];
    const name = rawName.toLowerCase();
    const text = src.slice(last, m.index);
    last = m.index + whole.length;
    if (skipUntil) {
      if (slash && name === skipUntil) skipUntil = null;
      continue;
    }
    out += escapeText(text);
    if (!slash && DROP_WITH_CONTENT.has(name)) {
      if (!/\/\s*$/.test(attrs)) skipUntil = name;
      continue;
    }
    if (!ALLOWED.has(name)) continue;
    if (slash) {
      if (VOID.has(name)) continue;
      const i = open.lastIndexOf(name);
      if (i < 0) continue;
      // close anything left open inside it, then the tag itself
      while (open.length > i) out += `</${open.pop()}>`;
      continue;
    }
    if (name === 'a') {
      const href = hrefOf(attrs);
      if (!href) continue; // an anchor without a safe href is dropped, its text stays
      out += `<a href="${escapeAttr(href)}" rel="noopener noreferrer" target="_blank">`;
      open.push('a');
      continue;
    }
    if (VOID.has(name)) {
      out += `<${name}>`;
      continue;
    }
    out += `<${name}>`;
    open.push(name);
  }
  if (!skipUntil) {
    const tail = src.slice(last);
    // a dangling "<" with no closing ">" is text
    out += escapeText(tail);
  }
  while (open.length) out += `</${open.pop()}>`;
  return out.trim();
}

/** Plain text of (sanitised or raw) HTML: tags removed, block ends become line breaks, entities decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  const withBreaks = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(TAG_RE, (_w, _slash: string, name: string) => (BLOCK.has(name.toLowerCase()) ? '\n' : ''));
  return decodeEntities(withBreaks)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
