import { assert, assertEquals } from "@std/assert";
import { strToU8, zipSync } from "fflate";
import { testCtx } from "./util.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function touch(path: string, mtimeMs: number) {
  await Deno.mkdir(path, { recursive: true });
  await Deno.writeFile(`${path}/f`, strToU8("x"));
  await Deno.utime(path, new Date(mtimeMs), new Date(mtimeMs));
}

Deno.test("cache: pruneCache keeps newest N, skips partial/non-numeric", async () => {
  await withTempDir(async (dir) => {
    const now = Date.now();
    await touch(`${dir}/100`, now - 3000);
    await touch(`${dir}/200`, now - 2000);
    await touch(`${dir}/300`, now - 1000);
    await touch(`${dir}/400.partial`, now);
    await touch(`${dir}/notes`, now);
    const ctx = testCtx(dir, { cacheMaxRuns: 2 });
    await ctx.pruneCache();
    const names = new Set<string>();
    for await (const e of Deno.readDir(dir)) names.add(e.name);
    assert(!names.has("100"), "oldest numeric pruned");
    assert(names.has("200") && names.has("300"), "newest kept");
    assert(names.has("400.partial"), "partial kept");
    assert(names.has("notes"), "non-numeric kept");
  });
});

Deno.test("cache: pruneCache with maxRuns 0 prunes nothing", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir, { cacheMaxRuns: 0 });
    await touch(`${dir}/1`, Date.now() - 5000);
    await touch(`${dir}/2`, Date.now());
    await ctx.pruneCache();
    const names = new Set<string>();
    for await (const e of Deno.readDir(dir)) names.add(e.name);
    assertEquals(names, new Set(["1", "2"]));
  });
});

Deno.test("cache: concurrent ensureExtracted shares one inflight fetch", async () => {
  await withTempDir(async (dir) => {
    let artifactCalls = 0;
    let zipCalls = 0;
    const id = 7070;
    const ctx = testCtx(dir, {
      fetchImpl: (input) => {
        const url = String(input);
        if (url.endsWith("/zip")) {
          zipCalls++;
          return Promise.resolve(
            new Response(zipSync({ "simtx-1.0_amd64.deb": strToU8("d") }) as unknown as BodyInit),
          );
        }
        if (url.includes(`/actions/runs/${id}/artifacts`)) {
          artifactCalls++;
          return Promise.resolve(
            new Response(
              JSON.stringify({ artifacts: [{ id: 5, expired: false }] }),
              { headers: { "content-type": "application/json" } },
            ),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });
    const [a, b, c] = await Promise.all([
      ctx.ensureExtracted(id),
      ctx.ensureExtracted(id),
      ctx.ensureExtracted(id),
    ]);
    assertEquals(a, b);
    assertEquals(b, c);
    assertEquals(artifactCalls, 1, "one artifact listing");
    assertEquals(zipCalls, 1, "one zip download");
  });
});
