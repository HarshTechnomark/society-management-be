import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP writer (deflate, no ZIP64) for the society data export (6.6). Parts stay far below 4 GB (450 MB cap),
 * so ZIP64 is not needed. Entries are compressed when added, so `size` tracks the archive size as it grows.
 */
export class ZipBuilder {
  private chunks: Buffer[] = [];
  private central: Buffer[] = [];
  private offset = 0;
  private count = 0;

  constructor(private readonly at: Date = new Date()) {}

  /** Bytes the archive will have (written entries plus the central directory and end record). */
  get size(): number {
    return this.offset + this.central.reduce((a, b) => a + b.length, 0) + 22;
  }
  get entries(): number {
    return this.count;
  }

  private dosTime(): { time: number; date: number } {
    const d = this.at;
    return {
      time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
      date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    };
  }

  /** Size the entry would add (compressed), to decide on a new part before adding. */
  static estimate(name: string, data: Buffer): number {
    return deflateRawSync(data).length + 2 * Buffer.byteLength(name) + 30 + 46;
  }

  add(name: string, data: Buffer): void {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const { time, date } = this.dosTime();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(compressed.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(this.offset, 42);
    this.central.push(Buffer.concat([cen, nameBuf]));
    this.chunks.push(local, nameBuf, compressed);
    this.offset += local.length + nameBuf.length + compressed.length;
    this.count++;
  }

  finish(): Buffer {
    const dir = Buffer.concat(this.central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.count, 8);
    end.writeUInt16LE(this.count, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(this.offset, 16);
    return Buffer.concat([...this.chunks, dir, end]);
  }
}

/** Reads the entry names and contents of an archive written by `ZipBuilder` (tests and manifest checks). */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const csize = buf.readUInt32LE(p + 18);
    const nlen = buf.readUInt16LE(p + 26);
    const xlen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nlen).toString('utf8');
    const start = p + 30 + nlen + xlen;
    out.set(name, inflateRawSync(buf.subarray(start, start + csize)));
    p = start + csize;
  }
  return out;
}
