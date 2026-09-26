import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { strToU8, zipSync } from "fflate";
import { HttpError } from "../app.ts";
import { makeRun, runsResponse, testCtx } from "./util.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("github: gh sends auth headers to repo-scoped URL", async () => {
  await withTempDir(async (dir) => {
    let seenUrl = "";
    let seenAuth = "";
    let seenApiVersion = "";
    const ctx = testCtx(dir, {
      fetchImpl: (input, init) => {
        seenUrl = String(input);
        const h = new Headers(init?.headers);
        seenAuth = h.get("authorization")!;
        seenApiVersion = h.get("x-github-api-version")!;
        return Promise.resolve(runsResponse([makeRun()]));
      },
    });
    await ctx.resolveRun("build-linux.yml", "latest");
    assertStringIncludes(seenUrl, "https://api.github.com/repos/o/r/actions/workflows/");
    assertStringIncludes(seenUrl, "status=success");
    assertEquals(seenAuth, "Bearer test-token");
    assertEquals(seenApiVersion, "2022-11-28");
  });
});

Deno.test("github: malformed API payload becomes HttpError 502", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir, {
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ workflow_runs: [{ id: "nan" }] }), {
            headers: { "content-type": "application/json" },
          }),
        ),
    });
    const err = await assertRejects(() => ctx.resolveRun("build-linux.yml", "latest"));
    assert(err instanceof HttpError);
    assertEquals((err as HttpError).status, 502);
    assertStringIncludes((err as HttpError).message, "malformed");
  });
});

Deno.test("github: non-ok API response becomes HttpError 502", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir, {
      fetchImpl: () => Promise.resolve(new Response("nope", { status: 403 })),
    });
    const err = await assertRejects(() => ctx.resolveRun("build-linux.yml", "latest"));
    assert(err instanceof HttpError);
    assertEquals((err as HttpError).status, 502);
    assertStringIncludes((err as HttpError).message, "403");
  });
});

Deno.test("github: findRun branch filter (latest pin vs tag vs unfiltered)", async () => {
  await withTempDir(async (dir) => {
    const urls: string[] = [];
    const mk = (extra = {}) =>
      testCtx(dir, {
        ...extra,
        fetchImpl: (input) => {
          urls.push(String(input));
          return Promise.resolve(runsResponse([makeRun()]));
        },
      });
    await mk({ latestRef: "main" }).resolveRun("build-linux.yml", "latest");
    assertStringIncludes(urls[0], "branch=main");
    await mk().resolveRun("build-linux.yml", "latest");
    assert(!urls[1].includes("branch="), urls[1]);
    await mk().resolveRun("build-linux.yml", "v1.0.0");
    assertStringIncludes(urls[2], "branch=v1.0.0");
  });
});

Deno.test("github: resolveRun caches per workflow@ref and honors TTL", async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    const ctx = testCtx(dir, {
      latestTtlMs: 15,
      fetchImpl: () => {
        calls++;
        return Promise.resolve(runsResponse([makeRun()]));
      },
    });
    await ctx.resolveRun("build-linux.yml", "latest");
    await ctx.resolveRun("build-linux.yml", "latest");
    assertEquals(calls, 1);
    await ctx.resolveRun("build-linux.yml", "v1.0");
    assertEquals(calls, 2);
    await new Promise((r) => setTimeout(r, 25));
    await ctx.resolveRun("build-linux.yml", "latest");
    assertEquals(calls, 3);
  });
});

Deno.test("github: latestStatus picks newest built_at across platforms", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir, {
      fetchImpl: (input) => {
        const wf = String(input);
        const updated = wf.includes("linux")
          ? "2026-01-01T00:00:00Z"
          : wf.includes("windows")
          ? "2026-05-01T00:00:00Z"
          : "2026-03-01T00:00:00Z";
        return Promise.resolve(runsResponse([makeRun({ updated_at: updated })]));
      },
    });
    const s = await ctx.latestStatus();
    assertEquals(s.newest_built_at, "2026-05-01T00:00:00Z");
    assertEquals(s.linux!.built_at, "2026-01-01T00:00:00Z");
  });
});

Deno.test("github: downloadArtifact follows 302 without token, 502 on failure", async () => {
  await withTempDir(async (dir) => {
    const payload = new TextEncoder().encode("zip-bytes");
    const calls: Array<{ url: string; auth: string | null }> = [];
    const ctx = testCtx(dir, {
      fetchImpl: (input, init) => {
        const url = String(input);
        calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
        if (url.endsWith("/zip")) {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: "https://presigned.example/file" },
            }),
          );
        }
        return Promise.resolve(new Response(payload));
      },
    });
    const out = await ctx.downloadArtifact(77);
    assertEquals(out, payload);
    assertEquals(calls.length, 2);
    assert(calls[0].auth?.includes("Bearer"), "token on api call");
    assertEquals(calls[1].auth, null, "no token leaked to presigned URL");

    const failing = testCtx(dir, {
      fetchImpl: () => Promise.resolve(new Response("x", { status: 500 })),
    });
    const err = await assertRejects(() => failing.downloadArtifact(1));
    assertEquals((err as HttpError).status, 502);
  });
});

Deno.test("github: expired artifacts -> 410", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir, {
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ artifacts: [{ id: 1, expired: true }] }), {
            headers: { "content-type": "application/json" },
          }),
        ),
    });
    const err = await assertRejects(() => ctx.ensureExtracted(31337));
    assertEquals((err as HttpError).status, 410);
  });
});

Deno.test("github: getTargets serves fresh, then stale on failure", async () => {
  await withTempDir(async (dir) => {
    const runId = 5050;
    await Deno.mkdir(`${dir}/${runId}`, { recursive: true });
    await Deno.writeFile(
      `${dir}/${runId}/simtx-1.0_amd64.deb`,
      new TextEncoder().encode("deb"),
    );
    const okFetch = () => Promise.resolve(runsResponse([makeRun({ id: runId })]));
    const ctx = testCtx(dir, {
      latestTtlMs: 15,
      tagTtlMs: 15,
      targetsTtlMs: 15,
      fetchImpl: okFetch,
    });
    const fresh = await ctx.getTargets("latest") as {
      stale: boolean;
      targets: unknown[];
    };
    assertEquals(fresh.stale, false);

    ctx.setFetchImpl(() => Promise.reject(new Error("network down")));
    await new Promise((r) => setTimeout(r, 25));
    const stale = await ctx.getTargets("latest") as {
      stale: boolean;
      targets: unknown[];
    };
    assertEquals(stale.stale, true);
    assertEquals(stale.targets, fresh.targets);
  });
});

Deno.test("github: full extract pipeline writes files via .partial", async () => {
  await withTempDir(async (dir) => {
    const innerZip = zipSync({
      "out/simtx-2.0_amd64.deb": strToU8("deb-bytes"),
      "out/skip.txt": strToU8("x"),
    });
    const ctx = testCtx(dir, {
      fetchImpl: (input) => {
        const url = String(input);
        if (url.includes("/artifacts/") && url.includes("/zip")) {
          return Promise.resolve(new Response(innerZip as unknown as BodyInit));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ artifacts: [{ id: 9, expired: false }] }), {
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });
    const extracted = await ctx.ensureExtracted(6060);
    assertEquals(extracted, `${dir}/6060`);
    assertEquals(
      await Deno.readFile(`${dir}/6060/simtx-2.0_amd64.deb`),
      strToU8("deb-bytes"),
    );
    let partialExists = true;
    try {
      await Deno.stat(`${dir}/6060.partial`);
    } catch {
      partialExists = false;
    }
    assertEquals(partialExists, false);
  });
});
