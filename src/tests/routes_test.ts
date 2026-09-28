import {
  assertEquals,
  assertStringIncludes,
} from "@std/assert";
import { makeRun, req, runsResponse, testCtx } from "./util.ts";

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

Deno.test("routes: version set vs unset", async () => {
  await withTempDir(async (dir) => {
    const set = testCtx(dir, { versionReturn: "v0.0.1" });
    const res = await set.app.handle(req("/version"));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "v0.0.1\n");

    const unset = testCtx(dir);
    const missing = await unset.app.handle(req("/version"));
    assertEquals(missing.status, 503);
    assertStringIncludes(await missing.text(), "VERSION_RETURN");
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

Deno.test("routes: invalid ref rejected with 422 before any network", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir);
    const res = await ctx.app.handle(req("/api/targets/bad!ref"));
    assertEquals(res.status, 422);
  });
});

Deno.test("routes: param validation failures are 422 without network", async () => {
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

Deno.test("routes: arch aliases pass validation (reach network layer)", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir, {
      fetchImpl: () => Promise.resolve(new Response("err", { status: 500 })),
    });
    for (const path of [
      "/latest/app/linux/x86_64/deb",
      "/latest/app/macos/aarch64/dmg",
    ]) {
      const res = await ctx.app.handle(req(path));
      assertEquals(res.status, 502, path);
    }
  });
});

Deno.test("routes: seeded download GET + HEAD, legacy + canonical, cache headers", async () => {
  await withTempDir(async (dir) => {
    const runId = 4242;
    await Deno.mkdir(`${dir}/${runId}`, { recursive: true });
    await Deno.writeFile(
      `${dir}/${runId}/simtx-1.0_amd64.deb`,
      new TextEncoder().encode("fake-deb"),
    );
    await Deno.writeFile(
      `${dir}/${runId}/simtx-cli.exe`,
      new TextEncoder().encode("fake-exe"),
    );
    const run = makeRun({ id: runId, head_branch: "v1.2.3" });
    const ctx = testCtx(dir, {
      fetchImpl: () => Promise.resolve(runsResponse([run])),
    });

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

Deno.test("routes: missing file in artifact -> 404", async () => {
  await withTempDir(async (dir) => {
    const runId = 999;
    await Deno.mkdir(`${dir}/${runId}`, { recursive: true });
    await Deno.writeFile(`${dir}/${runId}/unrelated.txt`, new TextEncoder().encode("x"));
    const ctx = testCtx(dir, {
      fetchImpl: () => Promise.resolve(runsResponse([makeRun({ id: runId })])),
    });
    const res = await ctx.app.handle(req("/v9/app/linux/amd64/deb"));
    assertEquals(res.status, 404);
    assertStringIncludes(await res.text(), "No deb");
  });
});

Deno.test("routes: no successful build -> 404", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir, {
      fetchImpl: () => Promise.resolve(runsResponse([])),
    });
    const res = await ctx.app.handle(req("/v9/app/linux/amd64/deb"));
    assertEquals(res.status, 404);
    assertStringIncludes(await res.text(), "No successful linux build");
  });
});

Deno.test("routes: api/latest shape + status alias", async () => {  await withTempDir(async (dir) => {
    const byWorkflow = (wf: string) =>
      wf.includes("linux")
        ? makeRun({ id: 1, updated_at: "2026-01-01T00:00:00Z" })
        : wf.includes("windows")
        ? makeRun({ id: 2, updated_at: "2026-03-01T00:00:00Z" })
        : makeRun({ id: 3, updated_at: "2026-02-01T00:00:00Z" });
    const ctx = testCtx(dir, {
      versionReturn: "1.0",
      fetchImpl: (input) =>
        Promise.resolve(runsResponse([byWorkflow(String(input))])),
    });
    for (const path of ["/api/latest", "/api/status"]) {
      const res = await ctx.app.handle(req(path));
      assertEquals(res.status, 200, path);
      const body = await res.json() as {
        version: string;
        repo: string;
        newest_built_at: string;
      };
      assertEquals(body.version, "1.0");
      assertEquals(body.repo, "o/r");
      assertEquals(body.newest_built_at, "2026-03-01T00:00:00Z");
    }
  });
});

Deno.test("routes: appimage-zsync + sha256 kinds, range 206/416, accept-ranges", async () => {
  await withTempDir(async (dir) => {
    const runId = 777;
    await Deno.mkdir(`${dir}/${runId}`, { recursive: true });
    const enc = new TextEncoder();
    await Deno.writeFile(`${dir}/${runId}/simtx-x86_64.AppImage`, enc.encode("0123456789"));
    await Deno.writeFile(
      `${dir}/${runId}/simtx-x86_64.AppImage.zsync`,
      enc.encode("zsync-data"),
    );
    await Deno.writeFile(
      `${dir}/${runId}/simtx-x86_64.AppImage.sha256`,
      enc.encode("deadbeef ".padEnd(65, "0") + " simtx-x86_64.AppImage\n"),
    );
    const run = makeRun({ id: runId, head_branch: "main" });
    const ctx = testCtx(dir, {
      fetchImpl: () => Promise.resolve(runsResponse([run])),
    });

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
    const runId = 778;
    await Deno.mkdir(`${dir}/${runId}`, { recursive: true });
    const enc = new TextEncoder();
    await Deno.writeFile(`${dir}/${runId}/simtx-x86_64.AppImage`, enc.encode("img"));
    await Deno.writeFile(
      `${dir}/${runId}/simtx-x86_64.AppImage.zsync`,
      enc.encode("z"),
    );
    const hash = "a".repeat(64);
    await Deno.writeFile(
      `${dir}/${runId}/simtx-x86_64.AppImage.sha256`,
      enc.encode(`${hash}  simtx-x86_64.AppImage\n`),
    );
    const run = makeRun({ id: runId, head_branch: "main" });
    const ctx = testCtx(dir, {
      versionReturn: "0.1.0-alpha-5",
      fetchImpl: () => Promise.resolve(runsResponse([run])),
    });
    const res = await ctx.app.handle(req("/api/updates/latest"));
    assertEquals(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assertEquals(body["version"], "0.1.0-alpha-5");
    assertEquals(body["appimage_url"], "/main/app/linux/amd64/appimage");
    assertEquals(body["zsync_url"], "/main/app/linux/amd64/appimage-zsync");
    assertEquals(body["sha256_url"], "/main/app/linux/amd64/appimage-sha256");
    assertEquals(body["sha256"], hash);

    const unset = testCtx(dir, {
      fetchImpl: () => Promise.resolve(runsResponse([run])),
    });
    assertEquals((await unset.app.handle(req("/api/updates/latest"))).status, 503);
  });
});

Deno.test("routes: zsync missing from old artifact -> 404", async () => {
  await withTempDir(async (dir) => {
    const runId = 779;
    await Deno.mkdir(`${dir}/${runId}`, { recursive: true });
    await Deno.writeFile(
      `${dir}/${runId}/simtx-x86_64.AppImage`,
      new TextEncoder().encode("img"),
    );
    const ctx = testCtx(dir, {
      fetchImpl: () => Promise.resolve(runsResponse([makeRun({ id: runId })])),
    });
    assertEquals(
      (await ctx.app.handle(req("/v9/app/linux/amd64/appimage-zsync"))).status,
      404,
    );
  });
});
