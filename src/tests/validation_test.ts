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
  DownloadParamsSchema,
  EnvSchema,
  HttpError,
  parseOr422,
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
      { ref: "x", product: "app", os: "linux", arch: "amd64", kind: "xbps" },
      { ref: "x", product: "app", os: "linux", arch: "amd64", kind: "xbps" },
    ],
    [
      { ref: "x", product: "app", os: "linux", arch: "amd64", kind: "XBPS" },
      { ref: "x", product: "app", os: "linux", arch: "amd64", kind: "xbps" },
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

Deno.test("EnvSchema: defaults, coercion, optional upload token", () => {
  const cfg = EnvSchema.parse({});
  assertEquals(cfg.PORT, 8000);
  assertEquals(cfg.CACHE_DIR, "./cache");
  assertEquals(cfg.TAG_TTL, 300);
  assertEquals(cfg.UPLOAD_MAX_MB, 500);
  assertEquals(cfg.UPLOAD_TOKEN, undefined);

  const coerced = EnvSchema.parse({ PORT: "9000", UPLOAD_TOKEN: "secret" });
  assertEquals(coerced.PORT, 9000);
  assertEquals(coerced.UPLOAD_TOKEN, "secret");

  assert(!EnvSchema.safeParse({ PORT: "abc" }).success, "bad port fails");
  assert(!EnvSchema.safeParse({ TAG_TTL: "-1" }).success, "negative ttl fails");
  assert(!EnvSchema.safeParse({ UPLOAD_MAX_MB: "0" }).success, "zero max fails");
});

Deno.test("AppOptionsSchema: rejects bad config", () => {
  const good = {
    cacheDir: "/tmp/x",
    tagTtlMs: 1000,
    targetsTtlMs: 1000,
  };
  assert(AppOptionsSchema.safeParse(good).success);
  assert(!AppOptionsSchema.safeParse({ ...good, tagTtlMs: -1 }).success);
  assert(!AppOptionsSchema.safeParse({ ...good, tagTtlMs: NaN }).success);
  assert(!AppOptionsSchema.safeParse({ ...good, cacheDir: "" }).success);
  assert(!AppOptionsSchema.safeParse({ ...good, targetsTtlMs: -1 }).success);
});

Deno.test("createApp: invalid options throw HttpError 422 fast", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assert422(
      () =>
        createApp({
          cacheDir: dir,
          tagTtlMs: -5,
          targetsTtlMs: 1000,
        }),
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("TargetDefSchema: shipped table entries are all valid", () => {
  assertEquals(TARGET_DEFS.length, 13);
  for (const t of TARGET_DEFS) {
    assert(TargetDefSchema.safeParse(t).success, JSON.stringify(t));
  }
  assert(!TargetDefSchema.safeParse({ ...TARGET_DEFS[0], arch: "arm64" }).success);
  assert(!TargetDefSchema.safeParse({ ...TARGET_DEFS[0], kind: "exe" }).success);
});

Deno.test("parseOr422: 422 carries Zod default details", () => {
  const err = assert422(() => parseOr422(z.object({ a: z.number() }), {}));
  assertStringIncludes(err.message, "a");
  assert(parseOr422(z.object({ a: z.number() }), { a: 1 }).a === 1);
});
