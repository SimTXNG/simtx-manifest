// Fedora/DNF repository metadata generation (pure TS, no createrepo_c).
// Serves repodata/{repomd.xml[.asc],*-primary/filelists/other.xml.gz}
// from cached .rpm artifacts. Only what DNF needs; no comps, no sqlite.

export const RPM_SUITE = "fedora";

// --- RPM header parsing -------------------------------------------------------
// Layout: Lead(96B, magic ED AB EE DB) | SignatureHeader | MainHeader.
// Each header: magic(8E AD E8 01 00 00 00 00) u32be nIndex u32be dataLen,
// nIndex * (u32be tag, u32be type, u32be offset, u32be count), data blob.
// Types: 1 CHAR, 2 INT8, 3 INT16, 4 INT32, 5 INT64, 6 STRING, 7 BIN,
// 8 STRING_ARRAY, 9 I18NSTRING. INT16/32/64 values are naturally
// aligned inside data; strings are NUL-terminated.

const HEADER_MAGIC = [0x8e, 0xad, 0xe8, 0x01, 0x00, 0x00, 0x00, 0x00];

export interface RpmEntry {
  tag: number;
  type: number;
  count: number;
  values: (number | string | Uint8Array)[];
}

function u32be(dv: DataView, off: number): number {
  return dv.getUint32(off, false);
}

function parseHeader(
  data: Uint8Array,
  dv: DataView,
  off: number,
): { entries: Map<number, RpmEntry>; next: number } {
  for (let i = 0; i < 8; i++) {
    if (data[off + i] !== HEADER_MAGIC[i]) {
      throw new Error(`rpm: bad header magic at ${off}`);
    }
  }
  const nIndex = u32be(dv, off + 8);
  const dataLen = u32be(dv, off + 12);
  const dataOff = off + 16 + nIndex * 16;
  const entries = new Map<number, RpmEntry>();
  for (let i = 0; i < nIndex; i++) {
    const io = off + 16 + i * 16;
    const tag = u32be(dv, io);
    const type = u32be(dv, io + 4);
    const eoff = u32be(dv, io + 8);
    const count = u32be(dv, io + 12);
    entries.set(tag, readEntry(data, dv, dataOff, type, eoff, count));
  }
  return { entries, next: dataOff + dataLen };
}

function align(v: number, a: number): number {
  return (v + a - 1) & ~(a - 1);
}

function readEntry(
  data: Uint8Array,
  dv: DataView,
  base: number,
  type: number,
  eoff: number,
  count: number,
): RpmEntry {
  const tag = 0; // filled by caller
  void tag;
  const values: (number | string | Uint8Array)[] = [];
  const dec = new TextDecoder();
  if (type === 6 || type === 9) {
    // STRING / I18NSTRING: count NUL-terminated strings from eoff
    let p = base + eoff;
    for (let i = 0; i < count; i++) {
      let end = p;
      while (data[end] !== 0) end++;
      values.push(dec.decode(data.subarray(p, end)));
      p = end + 1;
    }
  } else if (type === 8) {
    // STRING_ARRAY: strings run back-to-back; count = number of strings
    let p = base + eoff;
    for (let i = 0; i < count; i++) {
      let end = p;
      while (data[end] !== 0) end++;
      values.push(dec.decode(data.subarray(p, end)));
      p = end + 1;
    }
  } else if (type === 3 || type === 4) {
    // INT16 / INT32, aligned
    const width = type === 3 ? 2 : 4;
    let p = align(base + eoff, width);
    for (let i = 0; i < count; i++) {
      values.push(width === 2 ? dv.getUint16(p, false) : u32be(dv, p));
      p += width;
    }
  } else if (type === 5) {
    let p = align(base + eoff, 8);
    for (let i = 0; i < count; i++) {
      values.push(Number(dv.getBigUint64(p, false)));
      p += 8;
    }
  } else {
    // CHAR / INT8 / BIN: raw bytes
    values.push(data.subarray(base + eoff, base + eoff + count));
  }
  return { tag, type, count, values };
}

export interface RpmInfo {
  name: string;
  version: string;
  release: string;
  epoch: string;
  summary: string;
  description: string;
  buildtime: string;
  size: string;
  license: string;
  url: string;
  arch: string;
  sourcerpm: string;
  provides: { name: string; flags: number; ver: string }[];
  requires: { name: string; flags: number; ver: string }[];
  conflicts: { name: string; flags: number; ver: string }[];
  obsoletes: { name: string; flags: number; ver: string }[];
  files: string[];
  changelog: { date: string; author: string; text: string }[];
}

const str = (e: RpmEntry | undefined): string =>
  e && typeof e.values[0] === "string" ? (e.values[0] as string) : "";
const num = (e: RpmEntry | undefined): string =>
  e && typeof e.values[0] === "number" ? String(e.values[0]) : "";
const strs = (e: RpmEntry | undefined): string[] =>
  e ? (e.values as string[]) : [];
const nums = (e: RpmEntry | undefined): number[] =>
  e ? (e.values as number[]) : [];

function depEntries(
  m: Map<number, RpmEntry>,
  nameTag: number,
  flagsTag: number,
  verTag: number,
): { name: string; flags: number; ver: string }[] {
  const names = strs(m.get(nameTag));
  const flags = nums(m.get(flagsTag));
  const vers = strs(m.get(verTag));
  return names.map((name, i) => ({
    name,
    flags: flags[i] ?? 0,
    ver: vers[i] ?? "",
  }));
}

// parseRpm reads name/version/deps/files from raw .rpm bytes (payload
// untouched).
export function parseRpm(data: Uint8Array): RpmInfo {
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  if (
    data[0] !== 0xed || data[1] !== 0xab || data[2] !== 0xee ||
    data[3] !== 0xdb
  ) {
    throw new Error("rpm: bad lead magic");
  }
  // Skip signature header: 8 magic + 8 counts, then index + blob.
  const sigN = u32be(dv, 96 + 8);
  const sigLen = u32be(dv, 96 + 12);
  let off = 96 + 16 + sigN * 16 + sigLen;
  off = (off + 7) & ~7; // 8-byte boundary
  const { entries: m } = parseHeader(data, dv, off);

  const dirnames = strs(m.get(1118));
  const basenames = strs(m.get(1117));
  const diridx = nums(m.get(1116));
  const files = basenames.map((b, i) => (dirnames[diridx[i]] ?? "") + b);

  const clTime = nums(m.get(1080));
  const clName = strs(m.get(1081));
  const clText = strs(m.get(1082));
  const changelog = clTime.map((t, i) => ({
    date: String(t),
    author: clName[i] ?? "",
    text: clText[i] ?? "",
  }));

  return {
    name: str(m.get(1000)),
    version: str(m.get(1001)),
    release: str(m.get(1002)),
    epoch: num(m.get(1003)) || "0",
    summary: str(m.get(1004)),
    description: str(m.get(1005)),
    buildtime: num(m.get(1006)),
    size: num(m.get(1009)) || num(m.get(5009)),
    license: str(m.get(1014)),
    url: str(m.get(1020)),
    arch: str(m.get(1022)),
    sourcerpm: str(m.get(1044)),
    provides: depEntries(m, 1047, 1112, 1113),
    requires: depEntries(m, 1049, 1048, 1050),
    conflicts: depEntries(m, 1054, 1053, 1055),
    obsoletes: depEntries(m, 1090, 1114, 1115),
    files,
    changelog,
  };
}

// --- XML builders ---------------------------------------------------------------

const xmlEsc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// RPMSENSE flag bits -> creatropo flag names.
function flagName(flags: number): string {
  const parts: string[] = [];
  if (flags & 2) parts.push("LT");
  if (flags & 4) parts.push("GT");
  if (flags & 8) parts.push("EQ");
  return parts.join(" ");
}

function depXml(
  deps: { name: string; flags: number; ver: string }[],
): string {
  if (!deps.length) return "";
  return deps.map((d) => {
    const f = flagName(d.flags);
    const attrs = [`name="${xmlEsc(d.name)}"`];
    if (f) attrs.push(`flags="${f}"`);
    if (d.ver) {
      // ver is EVR-ish "epoch:ver-rel" or plain; split best-effort
      const m = /^(?:(\d+):)?(.+?)(?:-(.+))?$/.exec(d.ver);
      if (m) {
        if (m[1]) attrs.push(`epoch="${m[1]}"`);
        attrs.push(`ver="${xmlEsc(m[2])}"`);
        if (m[3]) attrs.push(`rel="${xmlEsc(m[3])}"`);
      } else {
        attrs.push(`ver="${xmlEsc(d.ver)}"`);
      }
    }
    return `      <rpm:entry ${attrs.join(" ")}/>`;
  }).join("\n");
}

// buildPrimaryXml renders primary.xml (uncompressed).
export function buildPrimaryXml(
  pkgs: {
    info: RpmInfo;
    checksum: string;
    location: string;
    size: number;
    buildTime: string;
    fileTime: string;
  }[],
): string {
  const bodies = pkgs.map((p) => {
    const i = p.info;
    const prov = depXml(i.provides);
    const req = depXml(i.requires);
    const files = i.files.map((f) => `    <file>${xmlEsc(f)}</file>`).join("\n");
    return `<package type="rpm">
  <name>${xmlEsc(i.name)}</name>
  <arch>${xmlEsc(i.arch)}</arch>
  <version epoch="${xmlEsc(i.epoch)}" ver="${xmlEsc(i.version)}" rel="${xmlEsc(i.release)}"/>
  <checksum type="sha256" pkgid="YES">${p.checksum}</checksum>
  <summary>${xmlEsc(i.summary)}</summary>
  <description>${xmlEsc(i.description)}</description>
  <packager>${xmlEsc("")}</packager>
  <url>${xmlEsc(i.url)}</url>
  <time build="${p.buildTime}" file="${p.fileTime}"/>
  <size package="${p.size}" archive="${xmlEsc(i.size)}" installed="${xmlEsc(i.size)}"/>
  <location href="${xmlEsc(p.location)}"/>
  <format>
    <rpm:license>${xmlEsc(i.license)}</rpm:license>
    <rpm:vendor/>
    <rpm:group>Applications/Internet</rpm:group>
    <rpm:buildhost>simtx</rpm:buildhost>
    <rpm:sourcerpm>${xmlEsc(i.sourcerpm)}</rpm:sourcerpm>
    <rpm:provides>${prov ? "\n" + prov + "\n    " : ""}</rpm:provides>
    <rpm:requires>${req ? "\n" + req + "\n    " : ""}</rpm:requires>
    <rpm:conflicts>${
      i.conflicts.length
        ? "\n" + depXml(i.conflicts) + "\n    "
        : ""
    }</rpm:conflicts>
    <rpm:obsoletes>${
      i.obsoletes.length
        ? "\n" + depXml(i.obsoletes) + "\n    "
        : ""
    }</rpm:obsoletes>
${files}
  </format>
</package>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<metadata xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="${pkgs.length}">\n${bodies}\n</metadata>\n`;
}

// buildFilelistsXml renders filelists.xml (uncompressed).
export function buildFilelistsXml(
  pkgs: { info: RpmInfo; checksum: string }[],
): string {
  const bodies = pkgs.map((p) => {
    const i = p.info;
    const dirs = new Set<string>();
    const files: string[] = [];
    for (const f of i.files) {
      files.push(f);
      const parts = f.split("/");
      for (let k = 1; k < parts.length; k++) {
        dirs.add(parts.slice(0, k).join("/") + "/");
      }
    }
    const all = [...dirs, ...files].sort();
    const entries = all.map((f) =>
      f.endsWith("/")
        ? `  <file type="dir">${xmlEsc(f.slice(0, -1))}</file>`
        : `  <file>${xmlEsc(f)}</file>`
    ).join("\n");
    return `<package pkgid="${p.checksum}" name="${xmlEsc(i.name)}" arch="${xmlEsc(i.arch)}">\n  <version epoch="${xmlEsc(i.epoch)}" ver="${xmlEsc(i.version)}" rel="${xmlEsc(i.release)}"/>\n${entries}\n</package>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<filelists xmlns="http://linux.duke.edu/metadata/filelists" packages="${pkgs.length}">\n${bodies}\n</filelists>\n`;
}

// buildOtherXml renders other.xml (uncompressed).
export function buildOtherXml(
  pkgs: { info: RpmInfo; checksum: string }[],
): string {
  const bodies = pkgs.map((p) => {
    const i = p.info;
    const logs = i.changelog.map((c) =>
      `  <changelog author="${xmlEsc(c.author)}" date="${c.date}">${xmlEsc(c.text)}</changelog>`
    ).join("\n");
    return `<package pkgid="${p.checksum}" name="${xmlEsc(i.name)}" arch="${xmlEsc(i.arch)}">\n  <version epoch="${xmlEsc(i.epoch)}" ver="${xmlEsc(i.version)}" rel="${xmlEsc(i.release)}"/>\n${logs}\n</package>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<other xmlns="http://linux.duke.edu/metadata/other" packages="${pkgs.length}">\n${bodies}\n</other>\n`;
}

// buildRepomdXml renders repomd.xml (uncompressed).
export function buildRepomdXml(
  revision: string,
  files: { type: string; href: string; checksum: string; openChecksum: string; size: number; openSize: number; timestamp: string }[],
): string {
  const bodies = files.map((f) =>
    `  <data type="${f.type}">\n    <location href="${xmlEsc(f.href)}"/>\n    <checksum type="sha256">${f.checksum}</checksum>\n    <open-checksum type="sha256">${f.openChecksum}</open-checksum>\n    <size>${f.size}</size>\n    <open-size>${f.openSize}</open-size>\n    <timestamp>${f.timestamp}</timestamp>\n  </data>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<repomd xmlns="http://linux.duke.edu/metadata/repo" xmlns:rpm="http://linux.duke.edu/metadata/rpm">\n  <revision>${revision}</revision>\n${bodies}\n</repomd>\n`;
}
