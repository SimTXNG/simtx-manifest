// Arch pacman repository database generation (pure TS, no repo-add).
// Serves simtx.db(.tar.gz[.sig]) + simtx.files(.tar.gz[.sig]) per arch
// from cached .pkg.tar.zst artifacts. Spec: alpm-repo-db/files v2.

import { decompress } from "fzstd";
import { gzipBytes, md5Hex, sha256Hex } from "./repo-util.ts";
import { listTar, writeTar } from "./repo-tar.ts";

export interface PkgFields {
  single: Record<string, string>;
  multi: Record<string, string[]>;
}

const MULTI_KEYS = new Set([
  "group",
  "license",
  "replaces",
  "conflict",
  "provides",
  "depend",
  "optdepend",
  "makedepend",
  "checkdepend",
  "backup",
]);

// parsePkginfo parses .PKGINFO (key = value, # comments, repeated keys
// form arrays).
export function parsePkginfo(text: string): PkgFields {
  const single: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (MULTI_KEYS.has(k)) {
      (multi[k] ??= []).push(v);
    } else {
      single[k] = v;
    }
  }
  return { single, multi };
}

export interface DescInput {
  filename: string;
  fields: PkgFields;
  csize: number;
  md5: string;
  sha256: string;
  // base64 single-line detached signature, when the .sig sidecar exists
  pgpsig?: string;
}

// buildDesc renders one desc entry. Empty multi sections are omitted;
// empty single sections (except required) are omitted.
export function buildDesc(p: DescInput): string {
  const { single: s, multi: m } = p.fields;
  const S = (h: string, v?: string) => v ? `%${h}%\n${v}\n\n` : "";
  const M = (h: string, vs?: string[]) =>
    vs && vs.length ? `%${h}%\n${vs.join("\n")}\n\n` : "";
  return S("FILENAME", p.filename) +
    S("NAME", s.pkgname) +
    S("BASE", s.pkgbase ?? s.pkgname) +
    S("VERSION", s.pkgver) +
    S("DESC", s.pkgdesc) +
    M("GROUPS", m.group) +
    S("CSIZE", String(p.csize)) +
    S("ISIZE", s.size) +
    S("MD5SUM", p.md5) +
    S("SHA256SUM", p.sha256) +
    S("PGPSIG", p.pgpsig) +
    S("URL", s.url) +
    M("LICENSE", m.license) +
    S("ARCH", s.arch) +
    S("BUILDDATE", s.builddate) +
    S("PACKAGER", s.packager) +
    M("REPLACES", m.replaces) +
    M("CONFLICTS", m.conflict) +
    M("PROVIDES", m.provides) +
    M("DEPENDS", m.depend) +
    M("OPTDEPENDS", m.optdepend) +
    M("MAKEDEPENDS", m.makedepend) +
    M("CHECKDEPENDS", m.checkdepend) +
    M("BACKUP", m.backup);
}

const META_ENTRIES = new Set([".PKGINFO", ".BUILDINFO", ".MTREE", ".INSTALL"]);

// buildFilesList renders the files db body from package tar entry names:
// lexically sorted, dirs with trailing slash, metadata excluded.
export function buildFilesList(names: string[]): string {
  const dirs = new Set<string>();
  const files: string[] = [];
  for (let n of names) {
    n = n.replace(/^\.\//, "");
    if (META_ENTRIES.has(n) || n === "") continue;
    files.push(n);
    const parts = n.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/") + "/");
    }
  }
  const all = [...dirs, ...files].sort();
  return `%FILES%\n${all.join("\n")}\n`;
}

export interface ArchPackage {
  filename: string;
  pkgname: string;
  pkgver: string;
  arch: string;
  desc: string;
  filesBody: string;
}

// archPackageForBytes builds db inputs from raw package bytes (+ optional
// detached signature bytes). Throws on missing/invalid .PKGINFO.
export async function archPackageForBytes(
  filename: string,
  pkgBytes: Uint8Array,
  sigBytes?: Uint8Array,
): Promise<ArchPackage> {
  const tar = decompress(pkgBytes);
  const entries = listTar(tar);
  const info = entries.find((e) => e.name === ".PKGINFO" || e.name === "./.PKGINFO");
  if (!info) throw new Error(`arch: ${filename} has no .PKGINFO`);
  const fields = parsePkginfo(new TextDecoder().decode(info.data));
  if (!fields.single.pkgname || !fields.single.pkgver || !fields.single.arch) {
    throw new Error(`arch: ${filename} .PKGINFO missing pkgname/pkgver/arch`);
  }
  const [md5, sha256] = [md5Hex(pkgBytes), await sha256Hex(pkgBytes)];
  let pgpsig: string | undefined;
  if (sigBytes) {
    let b64 = "";
    for (let i = 0; i < sigBytes.length; i += 0x8000) {
      b64 += String.fromCharCode(...sigBytes.subarray(i, i + 0x8000));
    }
    pgpsig = btoa(b64);
  }
  const desc = buildDesc({
    filename,
    fields,
    csize: pkgBytes.length,
    md5,
    sha256,
    pgpsig,
  });
  const filesBody = buildFilesList(entries.map((e) => e.name));
  return {
    filename,
    pkgname: fields.single.pkgname,
    pkgver: fields.single.pkgver,
    arch: fields.single.arch,
    desc,
    filesBody,
  };
}

// buildArchDb packs db + files tarballs, gzipped. Each entry directory
// is name-version from the package's own NAME/VERSION.
export async function buildArchDb(
  pkgs: ArchPackage[],
): Promise<{ db: Uint8Array; files: Uint8Array }> {
  const dbFiles: Record<string, Uint8Array> = {};
  const filesFiles: Record<string, Uint8Array> = {};
  const enc = new TextEncoder();
  for (const p of pkgs) {
    const dir = `${p.pkgname}-${p.pkgver}`;
    dbFiles[`${dir}/desc`] = enc.encode(p.desc);
    filesFiles[`${dir}/desc`] = enc.encode(p.desc);
    filesFiles[`${dir}/files`] = enc.encode(p.filesBody);
  }
  const [db, files] = await Promise.all([
    gzipBytes(writeTar(dbFiles)),
    gzipBytes(writeTar(filesFiles)),
  ]);
  return { db, files };
}
