// Minimal tar reader/writer (ustar). Enough for .PKGINFO extraction,
// file listings (pacman .files db), and writing repo db tarballs.

export interface TarEntry {
  name: string;
  size: number;
  data: Uint8Array;
}

function readStr(buf: Uint8Array, off: number, len: number): string {
  let end = off;
  while (end < off + len && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(off, end));
}

function readOct(buf: Uint8Array, off: number, len: number): number {
  const s = readStr(buf, off, len).trim().replace(/\0/g, "");
  if (s === "") return 0;
  return parseInt(s, 8);
}

// listTar parses all file entries (type '0'/'\0'), resolving GNU long
// names (type 'L'). Directories and other types are skipped, except
// that directory names are NOT needed by callers (files db derives
// them from file paths).
export function listTar(data: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= data.length) {
    const name = readStr(data, off, 100);
    if (name === "") break; // end-of-archive zero block
    const size = readOct(data, off + 124, 12);
    const type = String.fromCharCode(data[off + 156]);
    const dataOff = off + 512;
    if (type === "L") {
      longName = readStr(data, dataOff, size);
    } else if (type === "0" || type === "\0") {
      const entryName = longName ?? name;
      longName = null;
      out.push({
        name: entryName,
        size,
        data: data.subarray(dataOff, dataOff + size),
      });
    } else {
      longName = null;
    }
    off = dataOff + Math.ceil(size / 512) * 512;
  }
  return out;
}

function writeStr(buf: Uint8Array, off: number, len: number, s: string) {
  const enc = new TextEncoder().encode(s);
  buf.set(enc.subarray(0, len), off);
}

function writeOct(buf: Uint8Array, off: number, len: number, v: number) {
  const s = v.toString(8).padStart(len - 1, "0");
  writeStr(buf, off, len - 1, s);
}

// writeTar packs name->bytes as ustar regular files (mode 644).
// Names over 100 chars use GNU long-name entries.
export function writeTar(files: Record<string, Uint8Array>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const pushHeader = (name: string, size: number, type: number) => {
    const h = new Uint8Array(512);
    writeStr(h, 0, 100, name);
    writeOct(h, 100, 8, 0o644);
    writeOct(h, 108, 8, 0);
    writeOct(h, 116, 8, 0);
    writeOct(h, 124, 12, size);
    writeOct(h, 136, 12, 0);
    h[156] = type; // '0' regular, 'L' GNU long name
    writeStr(h, 257, 6, "ustar");
    writeStr(h, 263, 2, "00");
    // checksum with spaces in its field
    writeStr(h, 148, 8, "        ");
    let sum = 0;
    for (const b of h) sum += b;
    writeOct(h, 148, 8, sum);
    h[155] = 0x20; // trailing space per spec (writeOct NULs it; fix)
    chunks.push(h);
  };
  for (const [name, data] of Object.entries(files)) {
    if (name.length > 100) {
      const enc = new TextEncoder().encode(name + "\0");
      pushHeader("././@LongLink", enc.length, 0x4c);
      chunks.push(enc);
      const pad = (512 - (enc.length % 512)) % 512;
      if (pad) chunks.push(new Uint8Array(pad));
    }
    pushHeader(name.length <= 100 ? name : name.slice(0, 100), data.length, 0x30);
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(1024)); // two zero blocks
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
