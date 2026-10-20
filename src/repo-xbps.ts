// XBPS/Void Linux repository support: read .xbps props, build the
// x86_64-repodata archive, and sign packages (.sig2) with RSA.

import {
  constants,
  createPrivateKey,
  createPublicKey,
  sign as rsaSign,
} from "node:crypto";
import { decompress } from "fzstd";
import { parsePlist, serializePlist } from "./repo-plist.ts";
import type { PlistDict, PlistValue } from "./repo-plist.ts";
import { listTar, writeTar } from "./repo-tar.ts";
import { gunzipBytes, gzipBytes, md5Hex, sha256Hex } from "./repo-util.ts";
import { HttpError } from "./validation.ts";

export const XBPS_ARCH = "x86_64";
export const XBPS_REPODATA = `${XBPS_ARCH}-repodata`;

const DEFAULT_SIGNED_BY = "SimTX XBPS Repository <packages@simtx.net>";

export interface XbpsPackage {
  props: PlistDict;
  pkgname: string;
  pkgver: string;
  architecture: string;
  fileName: string;
}

export interface XbpsSigner {
  sign(data: Uint8Array): Uint8Array;
  publicKeyPem: string;
  publicKeyBytes: Uint8Array;
  bits: number;
  fingerprint: string;
}

export interface XbpsRepoFiles {
  repodata: Uint8Array;
  sig2: Uint8Array;
  fileName: string;
  pkgname: string;
  pkgver: string;
  fingerprint: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+~:-]*$/;

function isDict(v: PlistValue | undefined): v is PlistDict {
  return !!v && typeof v === "object" && !Array.isArray(v) &&
    !(v instanceof Uint8Array);
}

function requiredString(
  dict: PlistDict,
  key: string,
  context: string,
): string {
  const v = dict[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new HttpError(502, `xbps ${context}: missing ${key}`);
  }
  return v;
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[i] !== sig[i]) return false;
  }
  return true;
}

async function decompressPackage(bytes: Uint8Array): Promise<Uint8Array> {
  if (startsWith(bytes, [0x28, 0xb5, 0x2f, 0xfd])) {
    try {
      return decompress(bytes);
    } catch (e) {
      throw new HttpError(
        502,
        `xbps package: invalid zstd archive: ${(e as Error).message}`,
      );
    }
  }
  if (startsWith(bytes, [0x1f, 0x8b])) {
    try {
      return await gunzipBytes(bytes);
    } catch (e) {
      throw new HttpError(
        502,
        `xbps package: invalid gzip archive: ${(e as Error).message}`,
      );
    }
  }
  if (
    startsWith(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) ||
    startsWith(bytes, [0x42, 0x5a, 0x68]) ||
    startsWith(bytes, [0x04, 0x22, 0x4d, 0x18]) ||
    startsWith(bytes, [0x1f, 0x9d])
  ) {
    throw new HttpError(
      502,
      "xbps package: unsupported compression (use zstd, gzip, or an uncompressed tar)",
    );
  }
  return bytes;
}

export async function parseXbpsPackage(
  bytes: Uint8Array,
): Promise<XbpsPackage> {
  const tar = await decompressPackage(bytes);
  let entries;
  try {
    entries = listTar(tar);
  } catch (e) {
    throw new HttpError(
      502,
      `xbps package: invalid tar archive: ${(e as Error).message}`,
    );
  }
  const entry = entries.find((e) =>
    e.name.replace(/^\.\//, "") === "props.plist"
  );
  if (!entry) {
    throw new HttpError(502, "xbps package: props.plist missing");
  }

  let parsed: PlistValue;
  try {
    parsed = parsePlist(dec.decode(entry.data));
  } catch (e) {
    throw new HttpError(
      502,
      `xbps package: invalid props.plist: ${(e as Error).message}`,
    );
  }
  if (!isDict(parsed)) {
    throw new HttpError(502, "xbps package: props.plist is not a dictionary");
  }

  const pkgname = requiredString(parsed, "pkgname", "package");
  const pkgver = requiredString(parsed, "pkgver", "package");
  const architecture = requiredString(parsed, "architecture", "package");
  requiredString(parsed, "version", "package");
  requiredString(parsed, "short_desc", "package");

  if (!SAFE_NAME.test(pkgname) || !SAFE_NAME.test(pkgver)) {
    throw new HttpError(502, "xbps package: unsafe pkgname/pkgver");
  }
  if (architecture !== XBPS_ARCH) {
    throw new HttpError(
      502,
      `xbps package: unexpected architecture "${architecture}" (want ${XBPS_ARCH})`,
    );
  }

  // Some packages store the full `name-version_rev` in pkgver (Void's
  // convention); the fixture and older builds store just `version_rev`.
  // XBPS builds download paths from pkgver, so never double the name.
  const fullPkgver = pkgver.startsWith(`${pkgname}-`)
    ? pkgver
    : `${pkgname}-${pkgver}`;
  return {
    props: parsed,
    pkgname,
    pkgver,
    architecture,
    fileName: `${fullPkgver}.${architecture}.xbps`,
  };
}

export function buildIndexEntry(
  props: PlistDict,
  sha256: string,
  size: number,
): PlistDict {
  const entry: PlistDict = { ...props };
  delete entry.pkgname;
  delete entry.version;
  delete entry["packaged-with"];
  entry["filename-sha256"] = sha256;
  entry["filename-size"] = size;
  return entry;
}

function b64urlDecode(s: string): Uint8Array {
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sshString(s: string): Uint8Array {
  const body = enc.encode(s);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

function sshMpint(bytes: Uint8Array): Uint8Array {
  const needsZero = bytes.length > 0 && (bytes[0] & 0x80) !== 0;
  const len = bytes.length + (needsZero ? 1 : 0);
  const out = new Uint8Array(4 + len);
  new DataView(out.buffer).setUint32(0, len);
  out.set(bytes, needsZero ? 5 : 4);
  return out;
}

function xbpsFingerprint(
  publicKey: ReturnType<typeof createPublicKey>,
): string {
  const jwk = publicKey.export({ format: "jwk" }) as {
    n?: string;
    e?: string;
  };
  if (!jwk.n || !jwk.e) throw new Error("RSA public key has no modulus");
  const n = b64urlDecode(jwk.n);
  const e = b64urlDecode(jwk.e);
  const blob = [
    sshString("ssh-rsa"),
    sshMpint(e),
    sshMpint(n),
  ];
  const total = blob.reduce((n, b) => n + b.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const part of blob) {
    joined.set(part, off);
    off += part.length;
  }
  const hex = md5Hex(joined);
  return hex.match(/../g)!.join(":");
}

export function loadXbpsSigningKey(
  pem: string,
  passphrase?: string,
): XbpsSigner {
  let privateKey;
  try {
    privateKey = passphrase
      ? createPrivateKey({ key: pem, format: "pem", passphrase })
      : createPrivateKey(pem);
  } catch (e) {
    throw new Error(`cannot read RSA private key: ${(e as Error).message}`);
  }
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = String(
    publicKey.export({ type: "spki", format: "pem" }),
  );
  const jwk = publicKey.export({ format: "jwk" }) as { n?: string };
  const bits = jwk.n ? b64urlDecode(jwk.n).length * 8 : 0;
  if (!bits) throw new Error("RSA private key has no modulus");

  return {
    sign(data: Uint8Array): Uint8Array {
      const sig = rsaSign("sha256", data, {
        key: privateKey,
        padding: constants.RSA_PKCS1_PADDING,
      });
      return new Uint8Array(sig);
    },
    publicKeyPem,
    publicKeyBytes: enc.encode(publicKeyPem),
    bits,
    fingerprint: xbpsFingerprint(publicKey),
  };
}

export async function buildXbpsRepo(
  pkg: XbpsPackage,
  packageBytes: Uint8Array,
  signer: XbpsSigner,
  signedBy = DEFAULT_SIGNED_BY,
): Promise<XbpsRepoFiles> {
  const sha256 = await sha256Hex(packageBytes);
  const index: PlistDict = {
    [pkg.pkgname]: buildIndexEntry(pkg.props, sha256, packageBytes.length),
  };
  const meta: PlistDict = {
    "signature-by": signedBy,
    "signature-type": "rsa",
    "public-key": signer.publicKeyBytes,
    "public-key-size": signer.bits,
  };
  const tar = writeTar({
    "index.plist": enc.encode(serializePlist(index)),
    "index-meta.plist": enc.encode(serializePlist(meta)),
    "stage.plist": new Uint8Array(),
  });
  const repodata = await gzipBytes(tar);
  return {
    repodata,
    sig2: signer.sign(packageBytes),
    fileName: pkg.fileName,
    pkgname: pkg.pkgname,
    pkgver: pkg.pkgver,
    fingerprint: signer.fingerprint,
  };
}
