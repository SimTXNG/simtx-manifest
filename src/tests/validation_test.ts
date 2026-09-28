import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { z } from "zod";
import { createApp } from "../app.ts";
import {
  AppOptionsSchema,
  ArtifactsSchema,
  DownloadParamsSchema,
  EnvSchema,
  HttpError,
  parseOr422,
  RunListSchema,
  TargetDefSchema,
} from "../validation.ts";
import { TARGET_DEFS } from "../app.ts";

function assert422(fn: () => unknown, msg?: string): HttpError {
  const err = assertThrows(fn, HttpError, undefined, msg);
  assertEquals((err as HttpError).status, 422, msg);
  return err as HttpError;
}

Deno.test("DownloadParamsSchema: canonical output incl. aliases + case folding", () => {
  const cases: Array<[Record<string, string>, Record<string, string>]> = [
    [
      { ref: "v1.0", product: "app", os: "linux", arch: "amd64", kind: "deb" },
      { ref: "v1.0", product: "app", os: "linux", arch: "amd64", kind: "deb" },
    ],
    [
      { ref: "LATEST", product: "APP", os: "Linux", arch: "AMD64", kind: "DEB" },
      { ref: "latest", product: "app", os: "linux", arch: "amd64", kind: "deb" },
    ],
    [
      { ref: "x", product: "app", os: "linux", arch: "x86_64", kind: "deb" },
      { ref: "x", product: "app", os: "linux", arch: "amd64", kind: "deb" },
    ],
    [
      { ref: "x", product: "app", os: "macos", arch: "aarch64", kind: "dmg" },
      { ref: "x", product: "app", os: "macos", arch: "arm64", kind: "dmg" },
    ],
    [
      { ref: "x", product: "app", os: "linux", arch: "amd64", kind: "pkg.tar.zst" },
      { ref: "x", product: "app", os: "linux", arch: "amd64", kind: "pkg.zst" },
    ],
    [
      { ref: "x", product: "app", os: "linux", arch: "amd64", kind: "ARCH" },
      { ref: "x", product: "app", os: "linux", arch: "amd64", kind: "pkg.zst" },
    ],
    [
      { ref: "x", product: "cli", os: "windows", arch: "amd64", kind: "exe" },
      { ref: "x", product: "cli", os: "windows", arch: "amd64", kind: "binary" },
    ],
  ];
  for (const [input, want] of cases) {
    assertEquals(parseOr422(DownloadParamsSchema, input), want, JSON.stringify(input));
  }
});

Deno.test("DownloadParamsSchema: rejects with 422 issue details", () => {
  const cases: Array<[Record<string, string>, string]> = [
    [
      { ref: "bad!ref", product: "app", os: "linux", arch: "amd64", kind: "deb" },
      "must match pattern",
    ],
    [
      { ref: "v1", product: "bogus", os: "linux", arch: "amd64", kind: "deb" },
      "Invalid option",
    ],
    [
      { ref: "v1", product: "app", os: "freebsd", arch: "amd64", kind: "deb" },
      "Invalid option",
    ],
    [
      { ref: "v1", product: "app", os: "linux", arch: "arm64", kind: "deb" },
      "linux arm64 is not available yet",
    ],
    [
      { ref: "v1", product: "app", os: "macos", arch: "amd64", kind: "dmg" },
      "macOS is arm64 (Apple Silicon) only",
    ],
    [
      { ref: "v1", product: "app", os: "linux", arch: "i386", kind: "deb" },
      "Invalid option",
    ],
    [
      { ref: "v1", product: "app", os: "linux", arch: "amd64", kind: "zip" },
      'Unsupported kind "zip"',
    ],
    [
      { ref: "v1", product: "cli", os: "linux", arch: "amd64", kind: "exe" },
      'Unsupported kind "exe"',
    ],
  ];
  for (const [input, msg] of cases) {
    const err = assert422(() => parseOr422(DownloadParamsSchema, input), JSON.stringify(input));
    assertStringIncludes(err.message, msg, JSON.stringify(input));
  }
});

Deno.test("EnvSchema: defaults, coercion, required token", () => {
  const cfg = EnvSchema.parse({ GITHUB_TOKEN: "t" });
  assertEquals(cfg.PORT, 8000);
  assertEquals(cfg.GITHUB_REPO, "simtxng/transmitter-go");
  assertEquals(cfg.PREFETCH, true);
  assertEquals(cfg.LATEST_TTL, 60);
  assertEquals(cfg.LINUX_WORKFLOW, "build-linux.yml");

  const off = EnvSchema.parse({ GITHUB_TOKEN: "t", PREFETCH: "0" });
  assertEquals(off.PREFETCH, false);

  const coerced = EnvSchema.parse({ GITHUB_TOKEN: "t", PORT: "9000" });
  assertEquals(coerced.PORT, 9000);

  assert(!EnvSchema.safeParse({}).success, "missing token fails");
  assert(!EnvSchema.safeParse({ GITHUB_TOKEN: "" }).success, "empty token fails");
  assert(!EnvSchema.safeParse({ GITHUB_TOKEN: "t", PORT: "abc" }).success, "bad port fails");
  assert(
    !EnvSchema.safeParse({ GITHUB_TOKEN: "t", CACHE_MAX_RUNS: "-1" }).success,
    "negative max runs fails",
  );
});

Deno.test("AppOptionsSchema: rejects bad config", () => {
  const good = {
    repo: "o/r",
    token: "t",
    workflows: { linux: "a.yml", windows: "b.yml", macos: "c.yml" },
    cacheDir: "/tmp/x",
    latestTtlMs: 1000,
    tagTtlMs: 1000,
    targetsTtlMs: 1000,
    cacheMaxRuns: 5,
  };
  assert(AppOptionsSchema.safeParse(good).success);
  assert(!AppOptionsSchema.safeParse({ ...good, latestTtlMs: -1 }).success);
  assert(!AppOptionsSchema.safeParse({ ...good, latestTtlMs: NaN }).success);
  assert(!AppOptionsSchema.safeParse({ ...good, repo: "" }).success);
  assert(!AppOptionsSchema.safeParse({ ...good, cacheMaxRuns: 1.5 }).success);
  assert(
    !AppOptionsSchema.safeParse({
      ...good,
      workflows: { linux: "a.yml", windows: "b.yml" },
    }).success,
    "missing macos workflow fails",
  );
});

Deno.test("createApp: invalid options throw HttpError 422 fast", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assert422(
      () =>
        createApp({
          repo: "o/r",
          token: "t",
          workflows: { linux: "a.yml", windows: "b.yml", macos: "c.yml" },
          cacheDir: dir,
          latestTtlMs: -5,
          tagTtlMs: 1000,
          targetsTtlMs: 1000,
          cacheMaxRuns: 5,
        }),
      "negative TTL",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("GitHub payload schemas: reject malformed data", () => {
  const run = {
    id: 1,
    head_branch: "main",
    head_sha: "abc",
    run_number: 2,
    display_title: "t",
    name: "n",
    html_url: "https://x",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  };
  assert(RunListSchema.safeParse({ workflow_runs: [run] }).success);
  assert(!RunListSchema.safeParse({ workflow_runs: [{ ...run, id: "x" }] }).success);
  assert(!RunListSchema.safeParse({ workflow_runs: "x" }).success);
  assert(!RunListSchema.safeParse({}).success);
  assert(
    ArtifactsSchema.safeParse({ artifacts: [{ id: 1, expired: false }] }).success,
  );
  assert(!ArtifactsSchema.safeParse({ artifacts: [{ id: 1 }] }).success);
  assert(!ArtifactsSchema.safeParse({ artifacts: null }).success);
});

Deno.test("TargetDefSchema: shipped table entries are all valid", () => {
  assertEquals(TARGET_DEFS.length, 11);
  for (const t of TARGET_DEFS) {
    assert(TargetDefSchema.safeParse(t).success, JSON.stringify(t));
  }
  assert(!TargetDefSchema.safeParse({ ...TARGET_DEFS[0], arch: "arm64" }).success);
  assert(!TargetDefSchema.safeParse({ ...TARGET_DEFS[0], kind: "exe" }).success);
});

Deno.test("parseOr422: 422 carries Zod default details", () => {
  const err = assert422(() => parseOr422(RunListSchema, {}));
  assertStringIncludes(err.message, "workflow_runs");
  assert(parseOr422(z.object({ a: z.number() }), { a: 1 }).a === 1);
});
