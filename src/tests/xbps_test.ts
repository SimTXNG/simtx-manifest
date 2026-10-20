import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { decompress } from "fzstd";
import {
  buildIndexEntry,
  buildXbpsRepo,
  loadXbpsSigningKey,
  parseXbpsPackage,
} from "../repo-xbps.ts";
import { parsePlist, serializePlist } from "../repo-plist.ts";
import type { PlistDict } from "../repo-plist.ts";
import { gunzipBytes, gzipBytes, sha256Hex } from "../repo-util.ts";
import { listTar, writeTar } from "../repo-tar.ts";
import { req, seedUploadFixture, testCtx } from "./util.ts";

const FIX = new URL("./fixtures/", import.meta.url);
const PKG_NAME = "simtx-test-0.1.0_1.x86_64.xbps";

async function fixturePkg(): Promise<Uint8Array> {
  return await Deno.readFile(new URL(PKG_NAME, FIX));
}

async function fixtureKey(): Promise<string> {
  return await Deno.readTextFile(new URL("xbps-test-key.pem", FIX));
}

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function verifySignature(
  publicKeyPem: string,
  sig: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "spki",
    pemToDer(publicKeyPem) as unknown as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    sig as unknown as BufferSource,
    data as unknown as BufferSource,
  );
}

Deno.test("plist: roundtrip strings, numbers, data, arrays, dicts", () => {
  const value = {
    text: 'a & <b> "c"',
    int: 42,
    real: 1.5,
    yes: true,
    no: false,
    data: new Uint8Array([0, 1, 127, 255]),
    list: ["one", 2, false],
    nested: { key: "value" },
  };
  const back = parsePlist(serializePlist(value));
  assertEquals(back, value);
});

Deno.test("plist: parse a standard XML plist", () => {
  const v = parsePlist(`<?xml version="1.0"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "x">
<plist version="1.0">
<dict>
  <key>name</key><string>simtx-test</string>
  <key>size</key><integer>1234</integer>
  <key>ok</key><true/>
  <key>deps</key><array><string>glibc&gt;=2.38_1</string></array>
</dict>
</plist>`);
  assertEquals(v, {
    name: "simtx-test",
    size: 1234,
    ok: true,
    deps: ["glibc>=2.38_1"],
  });
});

Deno.test("xbps: parse fixture props", async () => {
  const pkg = await parseXbpsPackage(await fixturePkg());
  assertEquals(pkg.pkgname, "simtx-test");
  assertEquals(pkg.pkgver, "0.1.0_1");
  assertEquals(pkg.architecture, "x86_64");
  assertEquals(pkg.fileName, PKG_NAME);
  assertEquals(pkg.props.short_desc, "SimTX test package");
  assertEquals(pkg.props.long_desc, "Test & demo package for the XBPS repo.");
  assertEquals(pkg.props["installed_size"], 1234);
  assertEquals(pkg.props.run_depends, ["glibc>=2.38_1"]);
  assertEquals(pkg.props.preserve, true);
});

Deno.test("xbps: full pkgver does not duplicate the package name in filename", async () => {
  const props: PlistDict = {
    pkgname: "simtx",
    pkgver: "simtx-0.1.0alpha13_1",
    architecture: "x86_64",
    version: "0.1.0",
    short_desc: "SimTX",
  };
  const tar = writeTar({
    "props.plist": new TextEncoder().encode(serializePlist(props)),
  });
  const pkg = await parseXbpsPackage(tar);
  assertEquals(pkg.fileName, "simtx-0.1.0alpha13_1.x86_64.xbps");
});

Deno.test("xbps: accepts gzip and uncompressed packages", async () => {
  const tar = decompress(await fixturePkg());
  assertEquals((await parseXbpsPackage(tar)).pkgver, "0.1.0_1");
  const gz = await gzipBytes(tar);
  assertEquals((await parseXbpsPackage(gz)).pkgver, "0.1.0_1");
});

Deno.test("xbps: rejects unsupported compression and missing props", async () => {
  await assertRejects(
    () => parseXbpsPackage(new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0])),
    Error,
    "unsupported compression",
  );
  await assertRejects(
    () => parseXbpsPackage(new Uint8Array([1, 2, 3])),
    Error,
    "props.plist missing",
  );
});

Deno.test("xbps: index entry drops package-only fields", async () => {
  const pkg = await parseXbpsPackage(await fixturePkg());
  const data = await fixturePkg();
  const hash = await sha256Hex(data);
  const entry = buildIndexEntry(pkg.props, hash, data.length);
  assert(!("pkgname" in entry));
  assert(!("version" in entry));
  assert(!("packaged-with" in entry));
  assertEquals(entry.pkgver, pkg.pkgver);
  assertEquals(entry.architecture, "x86_64");
  assertEquals(entry["filename-sha256"], hash);
  assertEquals(entry["filename-size"], data.length);
});

Deno.test("xbps: repodata entries and RSA signature", async () => {
  const pkgBytes = await fixturePkg();
  const pkg = await parseXbpsPackage(pkgBytes);
  const signer = loadXbpsSigningKey(await fixtureKey());
  assertEquals(signer.bits, 2048);
  assertEquals(
    signer.fingerprint,
    "e0:08:85:49:d1:f2:1a:a4:36:16:cc:21:7f:a8:15:c3",
  );

  const files = await buildXbpsRepo(
    pkg,
    pkgBytes,
    signer,
    "Test XBPS <test@example.com>",
  );
  assertEquals(files.fileName, PKG_NAME);

  const tar = await gunzipBytes(files.repodata);
  const entries = listTar(tar);
  assertEquals(
    entries.map((e) => e.name),
    ["index.plist", "index-meta.plist", "stage.plist"],
  );
  assertEquals(entries[2].size, 0);

  const index = parsePlist(
    new TextDecoder().decode(entries[0].data),
  ) as PlistDict;
  const entry = index["simtx-test"] as PlistDict;
  assertEquals(entry.pkgver, "0.1.0_1");
  assertEquals(entry["filename-sha256"], await sha256Hex(pkgBytes));
  assertEquals(entry["filename-size"], pkgBytes.length);

  const meta = parsePlist(
    new TextDecoder().decode(entries[1].data),
  ) as PlistDict;
  assertEquals(meta["signature-by"], "Test XBPS <test@example.com>");
  assertEquals(meta["signature-type"], "rsa");
  assertEquals(meta["public-key-size"], 2048);
  const publicKeyPem = new TextDecoder().decode(
    meta["public-key"] as Uint8Array,
  );
  assertStringIncludes(publicKeyPem, "BEGIN PUBLIC KEY");

  assertEquals(files.sig2.length, 256);
  assert(await verifySignature(publicKeyPem, files.sig2, pkgBytes));
  assert(
    !(await verifySignature(publicKeyPem, files.sig2, new Uint8Array([1]))),
  );
});

function xbpsCtx(dir: string, key?: string) {
  return testCtx(dir, {
    xbpsSigningKey: key,
    xbpsSignedBy: "Test XBPS <test@example.com>",
  });
}

Deno.test("xbps routes: unsigned repo answers 503", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ctx = xbpsCtx(dir);
    const res = await ctx.app.handle(req("/xbps/x86_64-repodata"));
    assertEquals(res.status, 503);
    assertStringIncludes(await res.text(), "XBPS_SIGNING_KEY_FILE");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("xbps routes: repodata, package, sig2, pubkey + HEAD", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await seedUploadFixture(dir, "latest", "app", "linux", "amd64", "xbps", PKG_NAME);
    const ctx = xbpsCtx(dir, await fixtureKey());
    const pkgBytes = await fixturePkg();

    const repodata = await ctx.app.handle(req("/xbps/x86_64-repodata"));
    assertEquals(repodata.status, 200);
    assertEquals(repodata.headers.get("cache-control"), "no-cache");
    const tar = await gunzipBytes(
      new Uint8Array(await repodata.arrayBuffer()),
    );
    assertEquals(
      listTar(tar).map((e) => e.name),
      ["index.plist", "index-meta.plist", "stage.plist"],
    );

    const pkg = await ctx.app.handle(req(`/xbps/${PKG_NAME}`));
    assertEquals(pkg.status, 200);
    assertEquals(pkg.headers.get("x-release-ref"), "latest");
    assertEquals(
      new Uint8Array(await pkg.arrayBuffer()),
      pkgBytes,
    );

    const sig = await ctx.app.handle(req(`/xbps/${PKG_NAME}.sig2`));
    assertEquals(sig.status, 200);
    const sigBytes = new Uint8Array(await sig.arrayBuffer());
    assertEquals(sigBytes.length, 256);
    const key = loadXbpsSigningKey(await fixtureKey());
    assert(await verifySignature(key.publicKeyPem, sigBytes, pkgBytes));

    const head = await ctx.app.handle(
      req(`/xbps/${PKG_NAME}`, { method: "HEAD" }),
    );
    assertEquals(head.status, 200);
    assertEquals(await head.text(), "");

    const pub = await ctx.app.handle(req("/xbps/pubkey"));
    assertEquals(pub.status, 200);
    assertEquals(
      pub.headers.get("x-xbps-fingerprint"),
      key.fingerprint,
    );
    assertStringIncludes(await pub.text(), "BEGIN PUBLIC KEY");

    const headPub = await ctx.app.handle(
      req("/xbps/pubkey", { method: "HEAD" }),
    );
    assertEquals(headPub.status, 200);
    assertEquals(await headPub.text(), "");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("xbps routes: unknown package name 404", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await seedUploadFixture(dir, "latest", "app", "linux", "amd64", "xbps", PKG_NAME);
    const ctx = xbpsCtx(dir, await fixtureKey());
    const res = await ctx.app.handle(
      req("/xbps/simtx-9.9_1.x86_64.xbps"),
    );
    assertEquals(res.status, 404);
    const unknown = await ctx.app.handle(req("/xbps/not-a-package"));
    assertEquals(unknown.status, 404);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
