import { describe, expect, it } from 'vitest';
import { htmlToText, sanitizeHtml } from '../../../src/modules/communication/communication.notices.sanitize';
import { listNoticeTemplates } from '../../../src/modules/communication/communication.notices.templates';
import { pct } from '../../../src/modules/communication/communication.notices.reports';

describe('sanitizeHtml (BR-16-2)', () => {
  it('keeps the allow-list and drops everything else', () => {
    expect(sanitizeHtml('<p>Hi <strong>all</strong><br><em>now</em></p><ul><li>a</li></ul>')).toBe(
      '<p>Hi <strong>all</strong><br><em>now</em></p><ul><li>a</li></ul>',
    );
    expect(sanitizeHtml('<div class="x"><span style="color:red">text</span></div>')).toBe('text');
    expect(sanitizeHtml('<h1>big</h1><h3>ok</h3>')).toBe('big<h3>ok</h3>');
  });
  it('removes scripts and styles with their content, event handlers and comments', () => {
    expect(sanitizeHtml('a<script>alert(1)</script>b')).toBe('ab');
    expect(sanitizeHtml('<style>p{}</style>x<!-- hidden -->y')).toBe('xy');
    expect(sanitizeHtml('<p onclick="x()" style="a">t</p>')).toBe('<p>t</p>');
    expect(sanitizeHtml('<img src=x onerror=alert(1)>t')).toBe('t');
    expect(sanitizeHtml('<iframe src="https://e.com">no</iframe>yes')).toBe('yes');
  });
  it('accepts links only with https:// or / and adds rel and target', () => {
    expect(sanitizeHtml('<a href="https://a.in/x?y=1&z=2">go</a>')).toBe(
      '<a href="https://a.in/x?y=1&amp;z=2" rel="noopener noreferrer" target="_blank">go</a>',
    );
    expect(sanitizeHtml('<a href="/notices/3">in</a>')).toContain('href="/notices/3"');
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'http://a.in',
      '//evil.com',
      'data:text/html,x',
      'java&#x09;script:alert(1)',
      ' javascript:alert(1)',
    ])
      expect(sanitizeHtml(`<a href="${bad}">t</a>`)).toBe('t');
    expect(sanitizeHtml('<a href="https://a.in" onclick="x()" target="_self">t</a>')).toBe(
      '<a href="https://a.in" rel="noopener noreferrer" target="_blank">t</a>',
    );
  });
  it('escapes stray angle brackets and closes open tags', () => {
    expect(sanitizeHtml('1 < 2 and 3 > 2')).toBe('1 &lt; 2 and 3 &gt; 2');
    expect(sanitizeHtml('<p><strong>open')).toBe('<p><strong>open</strong></p>');
    expect(sanitizeHtml('<p>x</p></b>')).toBe('<p>x</p>');
    expect(sanitizeHtml('<scr<script>ipt>x</script>')).not.toContain('<script');
  });
  it('is idempotent', () => {
    const once = sanitizeHtml('<p>Tom &amp; Jerry <a href="https://a.in">x</a> <u>u</u></p>');
    expect(sanitizeHtml(once)).toBe(once);
  });
});

describe('htmlToText', () => {
  it('strips tags, breaks blocks and decodes entities', () => {
    expect(htmlToText('<p>One &amp; two</p><p>Three</p>')).toBe('One & two\nThree');
    expect(htmlToText('<ul><li>a</li><li>b</li></ul>')).toBe('a\nb');
    expect(htmlToText('')).toBe('');
  });
});

describe('template library (8.3)', () => {
  it('has 8 templates in 3 languages and filters by locale', () => {
    const all = listNoticeTemplates();
    expect(all).toHaveLength(24);
    expect(new Set(all.map(t => t.key)).size).toBe(8);
    const hi = listNoticeTemplates('hi-IN');
    expect(hi).toHaveLength(8);
    expect(hi.every(t => t.locale === 'hi-IN' && t.title.length >= 5 && t.body.length > 20)).toBe(true);
    expect(all.find(t => t.key === 'water_cut')).toMatchObject({
      kind: 'UTILITY_SHUTDOWN',
      utilityType: 'WATER',
    });
  });
});

describe('percentages', () => {
  it('rounds half up to one decimal', () => {
    expect(pct(45, 64)).toBe('70.3');
    expect(pct(0, 0)).toBe('0.0');
    expect(pct(1, 8)).toBe('12.5');
    expect(pct(2, 3)).toBe('66.7');
  });
});
