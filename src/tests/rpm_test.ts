import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import {
  buildFilelistsXml,
  buildOtherXml,
  buildPrimaryXml,
  buildRepomdXml,
  parseRpm,
  type RpmInfo,
} from "../repo-rpm.ts";
import { sha256Hex } from "../repo-util.ts";
import { makeRun, req, runsResponse, testCtx } from "./util.ts";

const TEST_FPR = "A5202902915B1536B896B54F864161347A1E7943";
const FIX = new URL("./fixtures/", import.meta.url);

function signedCtx(dir: string) {
  return testCtx(dir, {
    signingKey: Deno.readTextFileSync(
      new URL("./test-signing-key.asc", import.meta.url),
    ),
    signingKeyFpr: TEST_FPR,
  });
}

async function seedRun(dir: string, runId: number, ...files: string[]) {
  await Deno.mkdir(`${dir}/${runId}`, { recursive: true });
  for (const f of files) {
    await Deno.copyFile(new URL(f, FIX), `${dir}/${runId}/${f.split("/").pop()!}`);
  }
  return makeRun({ id: runId });
}

const info: RpmInfo = {
  name: "simtx",
  version: "0.1.0~alpha5",
  release: "1",
  epoch: "0",
  summary: "SimTX transmitter",
  description: "desc",
  buildtime: "1790000000",
  size: "100",
  license: "MIT",
  url: "https://simtx.net",
  arch: "x86_64",
  sourcerpm: "simtx-0.1.0~alpha5-1.src.rpm",
  provides: [{ name: "simtx", flags: 8, ver: "0.1.0~alpha5-1" }],
  requires: [{ name: "gtk4", flags: 0, ver: "" }],
  conflicts: [],
  obsoletes: [],
  files: ["/usr/bin/simtx"],
  changelog: [],
};

Deno.test("rpm: parse fixture header (matches real rpm tool output)", async () => {
  const data = await Deno.readFile(new URL("simtx-test.rpm", FIX));
  const p = parseRpm(data);
  assertEquals(p.name, "simtx-test");
  assertEquals(p.version, "1.0");
  assertEquals(p.release, "2");
  assertEquals(p.arch, "x86_64");
  assertEquals(p.license, "MIT");
  assertEquals(p.requires.map((r) => r.name), ["libc.so.6()(64bit)"]);
  assertEquals(p.provides, [{ name: "simtx-test", flags: 8, ver: "1.0-2" }]);
  assertEquals(p.files, ["/usr/bin/simtx-test"]);
});

Deno.test("rpm: parse real nfpm-built rpm", async () => {
  // Regenerated on demand; skipped when absent (CI builds it).
  let data: Uint8Array;
  try {
    data = await Deno.readFile(new URL("simtx-real.rpm", FIX));
  } catch {
    return;
  }
  const p = parseRpm(data);
  assertEquals(p.name, "simtx");
  assert(p.version.length > 0 && p.release.length > 0);
  assert(p.files.includes("/usr/bin/simtx"));
});

Deno.test("rpm: primary xml golden", () => {
  const xml = buildPrimaryXml([{
    info,
    checksum: "abc",
    location: "simtx-0.1.0~alpha5-1.x86_64.rpm",
    size: 10,
    buildTime: "1790000000",
    fileTime: "1790000001",
  }]);
  assertStringIncludes(xml, 'packages="1"');
  assertStringIncludes(xml, '<version epoch="0" ver="0.1.0~alpha5" rel="1"/>');
  assertStringIncludes(xml, '<checksum type="sha256" pkgid="YES">abc</checksum>');
  assertStringIncludes(xml, "<rpm:entry name=\"simtx\" flags=\"EQ\" ver=\"0.1.0~alpha5\" rel=\"1\"/>");
  assertStringIncludes(xml, "<rpm:entry name=\"gtk4\"/>");
  assertStringIncludes(xml, "<file>/usr/bin/simtx</file>");
});

Deno.test("rpm: filelists + other + repomd goldens", () => {
  const fl = buildFilelistsXml([{ info, checksum: "abc" }]);
  assertStringIncludes(fl, '<package pkgid="abc" name="simtx" arch="x86_64">');
  assertStringIncludes(fl, '<file type="dir">/usr/bin</file>');
  const other = buildOtherXml([{ info, checksum: "abc" }]);
  assertStringIncludes(other, "<other xmlns=");
  const repomd = buildRepomdXml("123", [{
    type: "primary",
    href: "repodata/primary.xml.gz",
    checksum: "c",
    openChecksum: "o",
    size: 1,
    openSize: 2,
    timestamp: "123",
  }]);
  assertStringIncludes(repomd, "<revision>123</revision>");
  assertStringIncludes(repomd, "<open-checksum type=\"sha256\">o</open-checksum>");
});

Deno.test("rpm: unsigned server answers 503 on repodata", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ctx = testCtx(dir, {
      fetchImpl: () => Promise.resolve(runsResponse([])),
    });
    for (const path of [
      "/rpmrepo/repodata/repomd.xml",
      "/rpmrepo/repodata/repomd.xml.asc",
      "/rpmrepo/repodata/primary.xml.gz",
      "/rpmrepo/simtx-1.0-2.x86_64.rpm",
    ]) {
      assertEquals((await ctx.app.handle(req(path))).status, 503, path);
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("rpm: repodata routes from fixture", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const run = await seedRun(dir, 9201, "simtx-test.rpm");
    const ctx = signedCtx(dir);
    ctx.setFetchImpl(() => Promise.resolve(runsResponse([run])));
    const repomd = await ctx.app.handle(req("/rpmrepo/repodata/repomd.xml"));
    assertEquals(repomd.status, 200);
    const repomdText = await repomd.text();
    assertStringIncludes(repomdText, "<data type=\"primary\">");
    const asc = await ctx.app.handle(req("/rpmrepo/repodata/repomd.xml.asc"));
    assertStringIncludes(await asc.text(), "PGP SIGNATURE");
    const primary = await ctx.app.handle(req("/rpmrepo/repodata/primary.xml.gz"));
    assertEquals(primary.status, 200);
    const filelists = await ctx.app.handle(req("/rpmrepo/repodata/filelists.xml.gz"));
    assertEquals(filelists.status, 200);
    const other = await ctx.app.handle(req("/rpmrepo/repodata/other.xml.gz"));
    assertEquals(other.status, 200);
    const pool = await ctx.app.handle(req("/rpmrepo/simtx-test-1.0-2.x86_64.rpm"));
    assertEquals(pool.status, 200);
    assertEquals(
      pool.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    const miss = await ctx.app.handle(req("/rpmrepo/other-9.9-9.x86_64.rpm"));
    assertEquals(miss.status, 404);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const buf = await new Response(
    new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds),
  ).arrayBuffer();
  return new Uint8Array(buf);
}

Deno.test("rpm: rebuild with same filename+length refreshes repodata checksum", async () => {
  // Regression test for `dnf update simtx` failing with
  // "checksum doesn't match" after rerunning build-linux.yml: the new
  // build kept the filename and byte length but changed bytes, and the
  // repodata cache (keyed on file+length) kept serving the old
  // primary.xml checksum against fresh pool bytes.
  const dir = await Deno.makeTempDir();
  try {
    const orig = await Deno.readFile(new URL("simtx-test.rpm", FIX));
    // Mutated rebuild: same length, different bytes. The last byte is
    // payload, so header parsing (name/version/release/arch) is intact.
    const rebuilt = orig.slice();
    rebuilt[rebuilt.length - 1] ^= 0xff;
    assertEquals(rebuilt.length, orig.length);
    assertNotEquals(
      await sha256Hex(rebuilt),
      await sha256Hex(orig),
    );

    const run1 = makeRun({ id: 9301 });
    const run2 = makeRun({ id: 9302 });
    let current = run1;
    await Deno.mkdir(`${dir}/9301`, { recursive: true });
    await Deno.writeFile(`${dir}/9301/simtx-test.rpm`, orig);
    await Deno.mkdir(`${dir}/9302`, { recursive: true });
    await Deno.writeFile(`${dir}/9302/simtx-test.rpm`, rebuilt);

    const ctx = testCtx(dir, {
      signingKey: Deno.readTextFileSync(
        new URL("./test-signing-key.asc", import.meta.url),
      ),
      signingKeyFpr: TEST_FPR,
      // No run-cache TTL so the second half resolves the new run while
      // the repodata cache persists — the stale-key scenario.
      latestTtlMs: 0,
      fetchImpl: () => Promise.resolve(runsResponse([current])),
    });

    const poolName = "simtx-test-1.0-2.x86_64.rpm";
    const pool1 = await ctx.app.handle(req(`/rpmrepo/${poolName}`));
    assertEquals(pool1.status, 200);
    const primary1 = await ctx.app.handle(req("/rpmrepo/repodata/primary.xml.gz"));
    assertEquals(primary1.status, 200);
    const text1 = new TextDecoder().decode(
      await gunzip(new Uint8Array(await primary1.arrayBuffer())),
    );
    assertStringIncludes(text1, await sha256Hex(orig));

    current = run2;
    const pool2 = await ctx.app.handle(req(`/rpmrepo/${poolName}`));
    assertEquals(pool2.status, 200);
    const pool2Hash = await sha256Hex(
      new Uint8Array(await pool2.arrayBuffer()),
    );
    assertEquals(pool2Hash, await sha256Hex(rebuilt));

    const primary2 = await ctx.app.handle(req("/rpmrepo/repodata/primary.xml.gz"));
    assertEquals(primary2.status, 200);
    const text2 = new TextDecoder().decode(
      await gunzip(new Uint8Array(await primary2.arrayBuffer())),
    );
    // Pool bytes and repodata must agree; the old checksum must be gone.
    assertStringIncludes(text2, pool2Hash);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
