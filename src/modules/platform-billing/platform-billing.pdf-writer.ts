/**
 * A very small PDF writer (A4, the two standard Helvetica fonts, text and lines) with no dependencies. Enough for the
 * invoice and credit note template; text is converted to WinAnsi (characters outside it become `?`).
 */
export const PAGE_W = 595.28;
export const PAGE_H = 841.89;

const REPLACE: Record<string, string> = {
  '₹': 'Rs.',
  '−': '-',
  '–': '-',
  '—': '-',
  '’': "'",
  '‘': "'",
  '“': '"',
  '”': '"',
  '·': '-',
};
const toWinAnsi = (s: string): Buffer => {
  let out = '';
  for (const ch of s) {
    const r = REPLACE[ch];
    if (r !== undefined) out += r;
    else out += ch.charCodeAt(0) <= 255 && ch.charCodeAt(0) >= 32 ? ch : '?';
  }
  return Buffer.from(out, 'latin1');
};
const esc = (b: Buffer): string => b.toString('latin1').replace(/([\\()])/g, '\\$1');

/** Approximate Helvetica advance widths (1/1000 em) by character class; exact for digits, which is what alignment needs. */
export function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of s) {
    if (/[0-9]/.test(ch)) w += 556;
    else if (ch === ' ') w += 278;
    else if (/[.,:;'!|]/.test(ch)) w += 278;
    else if (/[()\-/]/.test(ch)) w += 333;
    else if (/[MW]/.test(ch)) w += 833;
    else if (/[A-Z]/.test(ch)) w += 667;
    else if (/[ilj]/.test(ch)) w += 222;
    else if (/[mw]/.test(ch)) w += 778;
    else w += bold ? 580 : 540;
  }
  return (w * size) / 1000;
}

export class PdfDoc {
  private pages: string[][] = [[]];
  private font(bold: boolean): string {
    return bold ? 'F2' : 'F1';
  }
  get pageCount(): number {
    return this.pages.length;
  }
  addPage(): void {
    this.pages.push([]);
  }
  private cur(): string[] {
    return this.pages[this.pages.length - 1]!;
  }
  /** `y` is measured from the top of the page. */
  text(
    x: number,
    y: number,
    s: string,
    o: { size?: number; bold?: boolean; align?: 'left' | 'right' | 'center'; maxWidth?: number } = {},
  ): void {
    const size = o.size ?? 10;
    let str = s;
    if (o.maxWidth)
      while (str.length > 1 && textWidth(str, size, o.bold) > o.maxWidth) str = str.slice(0, -1);
    const w = textWidth(str, size, o.bold);
    const px = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    this.cur().push(
      `BT /${this.font(o.bold ?? false)} ${size} Tf ${px.toFixed(2)} ${(PAGE_H - y).toFixed(2)} Td (${esc(toWinAnsi(str))}) Tj ET`,
    );
  }
  line(x1: number, y1: number, x2: number, y2: number, width = 0.5): void {
    this.cur().push(
      `${width} w ${x1.toFixed(2)} ${(PAGE_H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(PAGE_H - y2).toFixed(2)} l S`,
    );
  }
  rect(x: number, y: number, w: number, h: number, gray?: number): void {
    const cmd = gray === undefined ? 'S' : 'f';
    this.cur().push(
      `${gray === undefined ? '' : `${gray} g `}${x.toFixed(2)} ${(PAGE_H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${cmd}${gray === undefined ? '' : ' 0 g'}`,
    );
  }

  /** The finished file. Objects: 1 catalog, 2 pages, 3 and 4 fonts, then (page, content) pairs. */
  build(title: string): Buffer {
    const objs: Buffer[] = [];
    const add = (s: string | Buffer): number => {
      objs.push(typeof s === 'string' ? Buffer.from(s, 'latin1') : s);
      return objs.length;
    };
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add('');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids: number[] = [];
    for (const p of this.pages) {
      const content = Buffer.from(p.join('\n'), 'latin1');
      const c = add(
        Buffer.concat([
          Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
          content,
          Buffer.from('\nendstream'),
        ]),
      );
      const pg = add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${c} 0 R >>`,
      );
      kids.push(pg);
    }
    objs[1] = Buffer.from(
      `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`,
      'latin1',
    );
    const info = add(`<< /Title (${esc(toWinAnsi(title))}) /Producer (SocietyApp) >>`);
    const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
    const offsets: number[] = [];
    let pos = chunks[0]!.length;
    objs.forEach((o, i) => {
      offsets.push(pos);
      const b = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
        o,
        Buffer.from('\nendobj\n', 'latin1'),
      ]);
      chunks.push(b);
      pos += b.length;
    });
    const xref =
      `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
      offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
    chunks.push(
      Buffer.from(
        `${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`,
        'latin1',
      ),
    );
    return Buffer.concat(chunks);
  }
}
