import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as openpgp from "openpgp";
import {
  archPackageForBytes,
  buildArchDb,
  buildDesc,
  buildFilesList,
  parsePkginfo,
} from "../repo-arch.ts";
import {
  buildRelease,
  debControlAsync,
  debFileName,
  packagesEntry,
  parseAr,
} from "../repo-apt.ts";
import { gzipBytes, md5Hex } from "../repo-util.ts";
import { listTar, writeTar } from "../repo-tar.ts";
import { clearSign, detachSign, loadSigningKey } from "../repo-sign.ts";
import { makeRun, req, runsResponse, testCtx } from "./util.ts";

const TEST_FPR = "A5202902915B1536B896B54F864161347A1E7943";
const FIX = new URL("./fixtures/", import.meta.url);

async function testKey() {
  const armored = await Deno.readTextFile(new URL("./test-signing-key.asc", import.meta.url));
  return loadSigningKey(armored, TEST_FPR);
}

function signedCtx(dir: string, fpr = TEST_FPR) {
  return testCtx(dir, {
    signingKey: Deno.readTextFileSync(
      new URL("./test-signing-key.asc", import.meta.url),
    ),
    signingKeyFpr: fpr,
  });
}

async function seedRun(dir: string, runId: number, ...files: string[]) {
  await Deno.mkdir(`${dir}/${runId}`, { recursive: true });
  for (const f of files) {
    await Deno.copyFile(new URL(f, FIX), `${dir}/${runId}/${f.split("/").pop()!}`);
  }
  return makeRun({ id: runId });
}

// --- pure builders ------------------------------------------------------------

Deno.test("repo: md5 known vector", () => {
  assertEquals(md5Hex(new TextEncoder().encode("abc")), "900150983cd24fb0d6963f7d28e17f72");
});

Deno.test("repo: tar roundtrip incl. long names", () => {
  const long = "a".repeat(120);
  const files = { "x": new TextEncoder().encode("data"), [long]: new TextEncoder().encode("y") };
  const back = Object.fromEntries(listTar(writeTar(files)).map((e) => [e.name, e.data]));
  assertEquals(new TextDecoder().decode(back["x"]), "data");
  assertEquals(new TextDecoder().decode(back[long]), "y");
});

Deno.test("repo: pkginfo parse + desc golden", () => {
  const fields = parsePkginfo("pkgname = foo\n# c\ndepend = a\ndepend = b\n");
  assertEquals(fields.single.pkgname, "foo");
  assertEquals(fields.multi.depend, ["a", "b"]);
  const desc = buildDesc({
    filename: "foo-1.0-1-x86_64.pkg.tar.zst",
    fields: parsePkginfo("pkgname = foo\npkgver = 1.0-1\narch = x86_64\ndepend = a\n"),
    csize: 10,
    md5: "m",
    sha256: "s",
  });
  assertStringIncludes(desc, "%FILENAME%\nfoo-1.0-1-x86_64.pkg.tar.zst\n\n");
  assertStringIncludes(desc, "%DEPENDS%\na\n\n");
  assert(!desc.includes("%PGPSIG%"));
  const signed = buildDesc({
    filename: "f",
    fields: parsePkginfo("pkgname = foo\npkgver = 1.0-1\narch = x86_64\n"),
    csize: 1,
    md5: "m",
    sha256: "s",
    pgpsig: "QUJD",
  });
  assertStringIncludes(signed, "%PGPSIG%\nQUJD\n\n");
});

Deno.test("repo: files list golden", () => {
  const body = buildFilesList([".PKGINFO", "usr/bin/x", "etc/y.conf"]);
  assertEquals(body, "%FILES%\netc/\netc/y.conf\nusr/\nusr/bin/\nusr/bin/x\n");
});

Deno.test("repo: release golden rows", () => {
  const rel = buildRelease("stable", ["amd64"], [
    { path: "main/binary-amd64/Packages", size: 4, md5: "m", sha1: "s1", sha256: "s2" },
  ], new Date("2026-09-28T12:00:00Z"));
  assertStringIncludes(rel, "Codename: stable\n");
  assertStringIncludes(rel, "SHA256:\n");
  assertStringIncludes(rel, " s2");
  assertStringIncludes(rel, "main/binary-amd64/Packages\n");
});

Deno.test("repo: ar + deb control parse from fixture", async () => {
  const deb = await Deno.readFile(new URL("simtx-test.deb", FIX));
  const members = parseAr(deb);
  assert("control.tar.gz" in members);
  const { stanza, fields } = await debControlAsync(deb);
  assertEquals(fields["Package"], "simtx-test");
  assertStringIncludes(stanza, "Description: test package\n long description here");
  assertEquals(debFileName(fields), "simtx-test_0.1.0~alpha5-1_amd64.deb");
  const entry = packagesEntry({
    filename: "latest/app/linux/amd64/deb",
    size: 1,
    md5: "m",
    sha1: "s1",
    sha256: "s2",
    stanza,
  });
  assertStringIncludes(entry, "Filename: latest/app/linux/amd64/deb\n");
});

Deno.test("repo: arch package from fixture zst", async () => {
  const pkg = await Deno.readFile(
    new URL("simtx-test-0.1.0alpha5-1-x86_64.pkg.tar.zst", FIX),
  );
  const sig = await Deno.readFile(
    new URL("simtx-test-0.1.0alpha5-1-x86_64.pkg.tar.zst.sig", FIX),
  );
  const ap = await archPackageForBytes("simtx-test-0.1.0alpha5-1-x86_64.pkg.tar.zst", pkg, sig);
  assertEquals(ap.pkgver, "0.1.0alpha5-1");
  assertEquals(ap.arch, "x86_64");
  assertStringIncludes(ap.desc, "%PGPSIG%\n");
  const { db, files } = await buildArchDb([ap]);
  const names = listTar(await gunzip(db)).map((e) => e.name);
  assertEquals(names, ["simtx-test-0.1.0alpha5-1/desc"]);
  assert(listTar(await gunzip(files)).some((e) => e.name.endsWith("/files")));
});

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const buf = await new Response(
    new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds),
  ).arrayBuffer();
  return new Uint8Array(buf);
}

// --- signing ------------------------------------------------------------------

Deno.test("repo: sign roundtrip with test key, wrong fpr rejected", async () => {
  const key = await testKey();
  const clear = await clearSign(key, "hello\n");
  assertStringIncludes(clear, "PGP SIGNED MESSAGE");
  const det = await detachSign(key, "hello\n");
  const armored = await Deno.readTextFile(new URL("./test-signing-key.asc", import.meta.url));
  const pub = await (await openpgp.readPrivateKey({ armoredKey: armored })).toPublic();
  const verified = await openpgp.verify({
    message: await openpgp.createMessage({ text: "hello\n" }),
    signature: await openpgp.readSignature({ armoredSignature: det }),
    verificationKeys: pub,
  });
  assertEquals(await verified.signatures[0]?.verified, true);
  // wrong fingerprint must fail
  let threw = false;
  try {
    await loadSigningKey(
      await Deno.readTextFile(new URL("./test-signing-key.asc", import.meta.url)),
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
  } catch {
    threw = true;
  }
  assert(threw, "wrong fpr accepted");
});

// --- routes -------------------------------------------------------------------

Deno.test("repo: unsigned server answers 503 on metadata, packages still 404/200", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ctx = testCtx(dir, {
      fetchImpl: () => Promise.resolve(runsResponse([])),
    });
    for (const path of [
      "/arch/x86_64/simtx.db",
      "/arch/x86_64/simtx.db.tar.gz.sig",
      "/dists/stable/Release",
      "/dists/stable/InRelease",
      "/dists/stable/Release.gpg",
      "/dists/stable/main/binary-amd64/Packages",
    ]) {
      const res = await ctx.app.handle(req(path));
      assertEquals(res.status, 503, path);
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("repo: arch db routes serve signed db from fixture", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const run = await seedRun(dir, 9101, "simtx-test-0.1.0alpha5-1-x86_64.pkg.tar.zst");
    const ctx = signedCtx(dir);
    ctx.setFetchImpl(() => Promise.resolve(runsResponse([run])));
    for (const path of ["/arch/x86_64/simtx.db", "/arch/x86_64/simtx.db.tar.gz"]) {
      const res = await ctx.app.handle(req(path));
      assertEquals(res.status, 200, path);
      const names = listTar(await gunzip(new Uint8Array(await res.arrayBuffer()))).map((e) => e.name);
      assertEquals(names, ["simtx-test-0.1.0alpha5-1/desc"]);
    }
    const sig = await ctx.app.handle(req("/arch/x86_64/simtx.db.tar.gz.sig"));
    assertEquals(sig.status, 200);
    assertStringIncludes(await sig.text(), "PGP SIGNATURE");
    const badArch = await ctx.app.handle(req("/arch/arm64/simtx.db"));
    assertEquals(badArch.status, 422);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("repo: apt routes serve signed Release + Packages from fixture", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const run = await seedRun(dir, 9102, "simtx-test.deb");
    const ctx = signedCtx(dir);
    ctx.setFetchImpl(() => Promise.resolve(runsResponse([run])));
    const rel = await ctx.app.handle(req("/dists/stable/Release"));
    assertEquals(rel.status, 200);
    const relText = await rel.text();
    assertStringIncludes(relText, "Codename: stable\n");
    assertStringIncludes(relText, "main/binary-amd64/Packages");
    const inRel = await ctx.app.handle(req("/dists/stable/InRelease"));
    assertStringIncludes(await inRel.text(), "PGP SIGNED MESSAGE");
    const gpg = await ctx.app.handle(req("/dists/stable/Release.gpg"));
    assertStringIncludes(await gpg.text(), "PGP SIGNATURE");
    const pkgs = await ctx.app.handle(req("/dists/stable/main/binary-amd64/Packages"));
    assertEquals(pkgs.status, 200);
    const pkgsText = await pkgs.text();
    assertStringIncludes(pkgsText, "Package: simtx-test");
    assertStringIncludes(pkgsText, "Filename: pool/main/simtx-test_0.1.0~alpha5-1_amd64.deb\n");
    const gz = await ctx.app.handle(req("/dists/stable/main/binary-amd64/Packages.gz"));
    assertEquals(gz.status, 200);
    const bad = await ctx.app.handle(req("/dists/oldstable/Release"));
    assertEquals(bad.status, 404);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("repo: pool serves deb under conventional filename", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const run = await seedRun(dir, 9103, "simtx-test.deb");
    const ctx = signedCtx(dir);
    ctx.setFetchImpl(() => Promise.resolve(runsResponse([run])));
    const good = await ctx.app.handle(req("/pool/main/simtx-test_0.1.0~alpha5-1_amd64.deb"));
    assertEquals(good.status, 200);
    assertEquals(good.headers.get("content-type"), "application/octet-stream");
    assertStringIncludes(
      good.headers.get("content-disposition")!,
      "simtx-test_0.1.0~alpha5-1_amd64.deb",
    );
    assertEquals(
      good.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    const wrong = await ctx.app.handle(req("/pool/main/other_1.0_amd64.deb"));
    assertEquals(wrong.status, 404);
    const badComp = await ctx.app.handle(req("/pool/contrib/simtx-test_0.1.0~alpha5-1_amd64.deb"));
    assertEquals(badComp.status, 404);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
