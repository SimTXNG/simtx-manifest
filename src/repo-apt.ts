// APT repository metadata generation (pure TS, no apt-ftparchive).
// Serves dists/stable/{InRelease,Release,Release.gpg} and
// main/binary-<arch>/Packages{,.gz} from cached .deb artifacts.

import { gunzipBytes, gzipBytes, md5Hex, sha1Hex, sha256Hex } from "./repo-util.ts";
import { listTar } from "./repo-tar.ts";

export const APT_SUITE = "stable";
export const APT_COMPONENT = "main";
export const APT_ORIGIN = "SimTX";

// --- .deb parsing ------------------------------------------------------------

// parseAr splits a GNU ar archive into name->bytes (skips symbol table).
export function parseAr(data: Uint8Array): Record<string, Uint8Array> {
  const magic = new TextDecoder().decode(data.subarray(0, 8));
  if (magic !== "!<arch>\n") throw new Error("apt: not an ar archive");
  const out: Record<string, Uint8Array> = {};
  const dec = new TextDecoder();
  let off = 8;
  while (off + 60 <= data.length) {
    const name = dec.decode(data.subarray(off, off + 16)).trim().replace(/\/$/, "");
    const size = parseInt(dec.decode(data.subarray(off + 48, off + 58)).trim(), 10);
    const start = off + 60;
    if (name !== "/" && name !== "//" && !name.startsWith("__.SYMDEF")) {
      out[name] = data.subarray(start, start + size);
    }
    off = start + size + (size % 2);
  }
  return out;
}

// debControlAsync extracts the control stanza + field map from .deb bytes.
export async function debControlAsync(
  deb: Uint8Array,
): Promise<{ stanza: string; fields: Record<string, string> }> {
  const members = parseAr(deb);
  const ctrlName = ["control.tar.zst", "control.tar.xz", "control.tar.gz"]
    .find((n) => members[n]);
  if (!ctrlName) throw new Error("apt: .deb has no control.tar.*");
  let tarBytes: Uint8Array;
  if (ctrlName.endsWith(".gz")) {
    tarBytes = await gunzipBytes(members[ctrlName]);
  } else {
    throw new Error(`apt: unsupported control compression ${ctrlName} (need control.tar.gz; nfpm emits data zst but control gz)`);
  }
  const entries = listTar(tarBytes);
  const ctrl = entries.find((e) => e.name === "./control" || e.name === "control");
  if (!ctrl) throw new Error("apt: control.tar has no ./control");
  const stanza = new TextDecoder().decode(ctrl.data);
  const fields: Record<string, string> = {};
  let current = "";
  for (const line of stanza.split("\n")) {
    if (line.startsWith(" ") && current) {
      fields[current] += "\n" + line;
    } else {
      const i = line.indexOf(":");
      if (i > 0) {
        current = line.slice(0, i);
        fields[current] = line.slice(i + 1).trim();
      }
    }
  }
  return { stanza, fields };
}

// debFileName returns the conventional pool filename
// (<package>_<version>_<arch>.deb). The .deb suffix is load-bearing:
// apt stages downloads into a temp dir and runs `dpkg --recursive`,
// which silently ignores files not matching *.deb.
export function debFileName(fields: Record<string, string>): string {
  return `${fields["Package"]}_${fields["Version"]}_${fields["Architecture"]}.deb`;
}

export interface AptPackage {
  filename: string; // repo-root-relative served path
  size: number;
  md5: string;
  sha1: string;
  sha256: string;
  stanza: string; // control stanza (Description already wrapped)
}

// packagesEntry renders one stanza with Filename/Size/checksums appended.
export function packagesEntry(p: AptPackage): string {
  return `${p.stanza.trimEnd()}\nFilename: ${p.filename}\nSize: ${p.size}\n` +
    `MD5sum: ${p.md5}\nSHA1: ${p.sha1}\nSHA256: ${p.sha256}\n`;
}

// --- Release -----------------------------------------------------------------

export interface ReleaseFile {
  path: string; // relative to dists/<suite>/
  data: Uint8Array;
}

// rfc2822 formats a Date like `date -Ru`.
function rfc2822(d: Date): string {
  return d.toUTCString();
}

// buildRelease renders the Release plaintext. hashes: hex per algorithm
// in apt's ` hex size path` row format.
export function buildRelease(
  suite: string,
  arches: string[],
  files: { path: string; size: number; md5: string; sha1: string; sha256: string }[],
  date: Date,
): string {
  const rows = (alg: "md5" | "sha1" | "sha256") =>
    files.map((f) => ` ${f[alg]} ${String(f.size).padStart(16)} ${f.path}`).join("\n");
  return `Origin: ${APT_ORIGIN}\nLabel: ${APT_ORIGIN}\nSuite: ${suite}\nCodename: ${suite}\n` +
    `Date: ${rfc2822(date)}\nArchitectures: ${arches.join(" ")}\nComponents: ${APT_COMPONENT}\n` +
    `Description: ${APT_ORIGIN} APT repository\nMD5Sum:\n${rows("md5")}\nSHA1:\n${rows("sha1")}\nSHA256:\n${rows("sha256")}\n`;
}

export async function hashFile(data: Uint8Array) {
  const [sha256, sha1] = await Promise.all([sha256Hex(data), sha1Hex(data)]);
  return { size: data.length, md5: md5Hex(data), sha1, sha256 };
}

export { gzipBytes };
