import {
  assertEquals,
  assertStringIncludes,
} from "@std/assert";
import { stripLeadingV } from "../app.ts";
import { req, seedUpload, testCtx } from "./util.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("routes: landing page GET + HEAD", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir);
    const get = await ctx.app.handle(req("/"));
    assertEquals(get.status, 200);
    assertStringIncludes(get.headers.get("content-type")!, "text/html");
    assertStringIncludes(await get.text(), "<!doctype html>");

    const index = await ctx.app.handle(req("/index.html"));
    assertEquals(index.status, 200);

    const head = await ctx.app.handle(req("/", { method: "HEAD" }));
    assertEquals(head.status, 200);
    assertStringIncludes(head.headers.get("content-type")!, "text/html");
    assertEquals(await head.text(), "");
  });
});

Deno.test("routes: install page GET + HEAD", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir);
    const get = await ctx.app.handle(req("/install"));
    assertEquals(get.status, 200);
    assertStringIncludes(get.headers.get("content-type")!, "text/html");
    const body = await get.text();
    assertStringIncludes(body, "Installing SimTX");
    assertStringIncludes(body, "manifest.simtx.net/pubkey");
    assertStringIncludes(body, "manifest.simtx.net/rpmrepo/");
    assertStringIncludes(body, "manifest.simtx.net/xbps");

    const head = await ctx.app.handle(req("/install", { method: "HEAD" }));
    assertEquals(head.status, 200);
    assertStringIncludes(head.headers.get("content-type")!, "text/html");
    assertEquals(await head.text(), "");
  });
});

Deno.test("routes: healthz GET + HEAD", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir);
    const get = await ctx.app.handle(req("/healthz"));
    assertEquals(get.status, 200);
    assertEquals(await get.text(), "ok\n");
    const head = await ctx.app.handle(req("/healthz", { method: "HEAD" }));
    assertEquals(head.status, 200);
  });
});

Deno.test("routes: version set vs unset falls back to newest uploaded tag", async () => {
  await withTempDir(async (dir) => {
    const set = testCtx(dir, { versionReturn: "v0.0.1" });
    const res = await set.app.handle(req("/version"));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "v0.0.1\n");

    await seedUpload(dir, "v0.1.0-alpha-5", "app", "linux", "amd64", "deb", "a.deb", "x");
    const fallback = testCtx(dir);
    const viaTag = await fallback.app.handle(req("/version"));
    assertEquals(viaTag.status, 200);
    assertEquals(await viaTag.text(), "0.1.0-alpha-5\n");
  });
});

Deno.test("routes: version fallback strips one leading v and ignores latest", async () => {
  await withTempDir(async (dir) => {
    await seedUpload(dir, "latest", "app", "linux", "amd64", "deb", "l.deb", "x");
    await seedUpload(dir, "v1.2.3", "app", "linux", "amd64", "deb", "a.deb", "x");
    const v = testCtx(dir);
    assertEquals(await (await v.app.handle(req("/version"))).text(), "1.2.3\n");

    await seedUpload(dir, "2.0.0", "app", "linux", "amd64", "deb", "b.deb", "y");
    const plain = testCtx(dir);
    assertEquals(await (await plain.app.handle(req("/version"))).text(), "2.0.0\n");
    assertEquals(stripLeadingV("v0.1.0-alpha-5"), "0.1.0-alpha-5");
    assertEquals(stripLeadingV("V2.0"), "2.0");
    assertEquals(stripLeadingV("1.0"), "1.0");
  });
});

Deno.test("routes: version fallback 503 when no uploaded tags", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir);
    const missing = await ctx.app.handle(req("/version"));
    assertEquals(missing.status, 503);
    assertStringIncludes(await missing.text(), "VERSION_RETURN");
  });
});

Deno.test("routes: version fallback caches the uploaded tag scan", async () => {
  await withTempDir(async (dir) => {
    await seedUpload(dir, "v3.2.1", "app", "linux", "amd64", "deb", "a.deb", "x");
    const ctx = testCtx(dir);
    assertEquals(await (await ctx.app.handle(req("/version"))).text(), "3.2.1\n");
    await seedUpload(dir, "v4.0.0", "app", "linux", "amd64", "deb", "b.deb", "y");
    assertEquals(await (await ctx.app.handle(req("/version"))).text(), "3.2.1\n");
  });
});

Deno.test("routes: unknown path 404, wrong method documents Elysia default", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir);
    const nope = await ctx.app.handle(req("/nope"));
    assertEquals(nope.status, 404);
    assertEquals(await nope.text(), "Not found\n");
    const post = await ctx.app.handle(req("/healthz", { method: "POST" }));
    assertEquals(post.status, 404);
  });
});

Deno.test("routes: invalid ref rejected with 422 before any upload lookup", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir);
    const res = await ctx.app.handle(req("/api/targets/bad!ref"));
    assertEquals(res.status, 422);
  });
});

Deno.test("routes: param validation failures are 422", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir);
    const cases: Array<[string, string]> = [
      ["/latest/app/linux/arm64/deb", "linux arm64 is not available yet"],
      ["/latest/app/macos/amd64/dmg", "macOS is arm64 (Apple Silicon) only"],
      ["/latest/app/linux/amd64/zip", 'Unsupported kind "zip"'],
      ["/latest/bogus/linux/amd64/deb", "Invalid option"],
      ["/latest/app/windows/arm64/exe", "windows arm64 is not available yet"],
      ["/latest/app/linux/i386/deb", "Invalid option"],
      ["/latest/app/freebsd/amd64/deb", "Invalid option"],
    ];
    for (const [path, msg] of cases) {
      const res = await ctx.app.handle(req(path));
      assertEquals(res.status, 422, path);
      assertStringIncludes(await res.text(), msg, path);
    }
  });
});

Deno.test("routes: arch aliases pass validation then 404 when not uploaded", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir);
    for (const path of [
      "/latest/app/linux/x86_64/deb",
      "/latest/app/macos/aarch64/dmg",
    ]) {
      const res = await ctx.app.handle(req(path));
      assertEquals(res.status, 404, path);
    }
  });
});

Deno.test("routes: seeded download GET + HEAD, legacy + canonical, cache headers", async () => {
  await withTempDir(async (dir) => {
    await seedUpload(dir, "v1.2.3", "app", "linux", "amd64", "deb", "simtx-1.0_amd64.deb", "fake-deb");
    await seedUpload(dir, "v1.2.3", "cli", "windows", "amd64", "binary", "simtx-cli.exe", "fake-exe");
    await seedUpload(dir, "latest", "app", "linux", "amd64", "deb", "simtx-1.0_amd64.deb", "fake-deb");
    const ctx = testCtx(dir);

    const get = await ctx.app.handle(req("/v1.2.3/app/linux/amd64/deb"));
    assertEquals(get.status, 200);
    assertEquals(get.headers.get("content-type"), "application/octet-stream");
    assertStringIncludes(
      get.headers.get("content-disposition")!,
      "simtx-1.0_amd64.deb",
    );
    assertEquals(get.headers.get("x-release-ref"), "v1.2.3");
    assertStringIncludes(get.headers.get("cache-control")!, "immutable");
    assertEquals(await get.text(), "fake-deb");

    const head = await ctx.app.handle(
      req("/v1.2.3/app/linux/amd64/deb", { method: "HEAD" }),
    );
    assertEquals(head.status, 200);
    assertEquals(
      head.headers.get("content-length"),
      String("fake-deb".length),
    );
    assertEquals(await head.text(), "");

    const legacy = await ctx.app.handle(req("/v1.2.3/linux/amd64/deb"));
    assertEquals(legacy.status, 200);

    const cli = await ctx.app.handle(req("/v1.2.3/cli/windows/amd64/exe"));
    assertEquals(cli.status, 200);
    assertEquals(await cli.text(), "fake-exe");

    const latest = await ctx.app.handle(req("/latest/app/linux/amd64/deb"));
    assertEquals(latest.status, 200);
    assertEquals(latest.headers.get("cache-control"), "no-cache");
  });
});

Deno.test("routes: missing upload -> 404", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir);
    const res = await ctx.app.handle(req("/v9/app/linux/amd64/deb"));
    assertEquals(res.status, 404);
    const body = await res.text();
    assertStringIncludes(body, "No deb");
    assertStringIncludes(body, "uploaded");
  });
});

Deno.test("routes: api/latest shape + status alias", async () => {
  await withTempDir(async (dir) => {
    const linux = await seedUpload(dir, "latest", "app", "linux", "amd64", "deb", "a.deb", "x");
    const windows = await seedUpload(dir, "latest", "app", "windows", "amd64", "exe", "a.exe", "x");
    const macos = await seedUpload(dir, "latest", "app", "macos", "arm64", "dmg", "a.dmg", "x");
    await Deno.utime(linux, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    await Deno.utime(windows, new Date("2026-03-01T00:00:00Z"), new Date("2026-03-01T00:00:00Z"));
    await Deno.utime(macos, new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));

    const ctx = testCtx(dir, { versionReturn: "1.0" });
    for (const path of ["/api/latest", "/api/status"]) {
      const res = await ctx.app.handle(req(path));
      assertEquals(res.status, 200, path);
      const body = await res.json() as {
        version: string;
        ref: string;
        newest_built_at: string;
        linux: { branch: string; built_at: string };
        windows: { built_at: string };
        macos: { built_at: string };
        repo?: string;
      };
      assertEquals(body.version, "1.0");
      assertEquals(body.ref, "latest");
      assertEquals(body.repo, undefined);
      assertEquals(body.newest_built_at, "2026-03-01T00:00:00.000Z");
      assertEquals(body.linux.branch, "latest");
      assertEquals(body.windows.built_at, "2026-03-01T00:00:00.000Z");
      assertEquals(body.macos.built_at, "2026-02-01T00:00:00.000Z");
    }
  });
});

Deno.test("routes: appimage-zsync + sha256 kinds, range 206/416, accept-ranges", async () => {
  await withTempDir(async (dir) => {
    const enc = new TextEncoder();
    await seedUpload(dir, "latest", "app", "linux", "amd64", "appimage", "simtx-x86_64.AppImage", enc.encode("0123456789"));
    await seedUpload(dir, "latest", "app", "linux", "amd64", "appimage-zsync", "simtx-x86_64.AppImage.zsync", enc.encode("zsync-data"));
    await seedUpload(
      dir,
      "latest",
      "app",
      "linux",
      "amd64",
      "appimage-sha256",
      "simtx-x86_64.AppImage.sha256",
      enc.encode("deadbeef ".padEnd(65, "0") + " simtx-x86_64.AppImage\n"),
    );
    const ctx = testCtx(dir, { versionReturn: "1.0" });

    const zsync = await ctx.app.handle(req("/latest/app/linux/amd64/appimage-zsync"));
    assertEquals(zsync.status, 200);
    assertEquals(zsync.headers.get("accept-ranges"), "bytes");
    assertEquals(await zsync.text(), "zsync-data");

    const sha = await ctx.app.handle(req("/latest/app/linux/amd64/appimage-sha256"));
    assertEquals(sha.status, 200);
    assertStringIncludes(await sha.text(), "simtx-x86_64.AppImage");

    const full = await ctx.app.handle(req("/latest/app/linux/amd64/appimage"));
    assertEquals(full.status, 200);
    assertEquals(full.headers.get("accept-ranges"), "bytes");

    const part = await ctx.app.handle(req("/latest/app/linux/amd64/appimage", {
      headers: { Range: "bytes=2-5" },
    }));
    assertEquals(part.status, 206);
    assertEquals(part.headers.get("content-range"), "bytes 2-5/10");
    assertEquals(await part.text(), "2345");

    const bad = await ctx.app.handle(req("/latest/app/linux/amd64/appimage", {
      headers: { Range: "bytes=50-60" },
    }));
    assertEquals(bad.status, 416);
  });
});

Deno.test("routes: api/updates/latest shape + version-unset 503", async () => {
  await withTempDir(async (dir) => {
    const enc = new TextEncoder();
    const hash = "a".repeat(64);
    await seedUpload(dir, "latest", "app", "linux", "amd64", "appimage", "simtx-x86_64.AppImage", enc.encode("img"));
    await seedUpload(dir, "latest", "app", "linux", "amd64", "appimage-zsync", "simtx-x86_64.AppImage.zsync", enc.encode("z"));
    await seedUpload(
      dir,
      "latest",
      "app",
      "linux",
      "amd64",
      "appimage-sha256",
      "simtx-x86_64.AppImage.sha256",
      enc.encode(`${hash}  simtx-x86_64.AppImage\n`),
    );
    const ctx = testCtx(dir, { versionReturn: "0.1.0-alpha-5" });
    const res = await ctx.app.handle(req("/api/updates/latest"));
    assertEquals(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assertEquals(body["version"], "0.1.0-alpha-5");
    assertEquals(body["ref"], "latest");
    assertEquals(body["appimage_url"], "/latest/app/linux/amd64/appimage");
    assertEquals(body["zsync_url"], "/latest/app/linux/amd64/appimage-zsync");
    assertEquals(body["sha256_url"], "/latest/app/linux/amd64/appimage-sha256");
    assertEquals(body["sha256"], hash);

    const unset = testCtx(dir);
    assertEquals((await unset.app.handle(req("/api/updates/latest"))).status, 503);

    await seedUpload(dir, "v0.1.0-alpha-5", "app", "linux", "amd64", "deb", "a.deb", "x");
    const viaTag = testCtx(dir);
    const tagged = await viaTag.app.handle(req("/api/updates/latest"));
    assertEquals(tagged.status, 200);
    assertEquals(
      (await tagged.json() as Record<string, unknown>)["version"],
      "0.1.0-alpha-5",
    );
  });
});

Deno.test("routes: zsync missing -> 404", async () => {
  await withTempDir(async (dir) => {
    await seedUpload(dir, "latest", "app", "linux", "amd64", "appimage", "simtx-x86_64.AppImage", "img");
    const ctx = testCtx(dir, { versionReturn: "1.0" });
    assertEquals(
      (await ctx.app.handle(req("/latest/app/linux/amd64/appimage-zsync"))).status,
      404,
    );
  });
});

Deno.test("routes: pubkey serves the signing key", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir);
    const get = await ctx.app.handle(req("/pubkey"));
    assertEquals(get.status, 200);
    assertStringIncludes(get.headers.get("content-type")!, "application/pgp-keys");
    assertStringIncludes(await get.text(), "BEGIN PGP PUBLIC KEY BLOCK");
    const head = await ctx.app.handle(req("/pubkey", { method: "HEAD" }));
    assertEquals(head.status, 200);
    assertEquals(await head.text(), "");
  });
});

Deno.test("routes: arch pkg detached signature downloads as pkg.zst.sig", async () => {
  await withTempDir(async (dir) => {
    const enc = new TextEncoder();
    await seedUpload(dir, "v9", "app", "linux", "amd64", "pkg.zst", "simtx-0.1.0alpha5-1-x86_64.pkg.tar.zst", enc.encode("pkg"));
    await seedUpload(dir, "v9", "app", "linux", "amd64", "pkg.zst.sig", "simtx-0.1.0alpha5-1-x86_64.pkg.tar.zst.sig", enc.encode("sig"));
    const ctx = testCtx(dir);
    const res = await ctx.app.handle(req("/v9/app/linux/amd64/pkg.zst.sig"));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "sig");
    assertStringIncludes(
      res.headers.get("content-disposition")!,
      "simtx-0.1.0alpha5-1-x86_64.pkg.tar.zst.sig",
    );
  });
});
