import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  json,
  matchesTarget,
  runInfo,
  text,
  type Run,
} from "../app.ts";
import {
  canonicalKind,
  HttpError,
  parseOr422,
  RefSchema,
  type Os,
  type Product,
} from "../validation.ts";

Deno.test("matchesTarget: app/linux kinds", () => {
  assert(matchesTarget("app", "linux", "deb", "simtx-1.0_amd64.deb"));
  assert(matchesTarget("app", "linux", "deb", "SIMTX-1.0_AMD64.DEB"));
  assert(!matchesTarget("app", "linux", "deb", "simtx-1.0_amd64.rpm"));
  assert(matchesTarget("app", "linux", "rpm", "simtx-1.0.rpm"));
  assert(!matchesTarget("app", "linux", "rpm", "simtx-1.0.deb"));
  assert(matchesTarget("app", "linux", "appimage", "SimTX-x86_64.AppImage"));
  assert(!matchesTarget("app", "linux", "appimage", "simtx.deb"));
  for (const kind of ["pkg.zst", "pkg.tar.zst", "arch"]) {
    assert(
      matchesTarget("app", "linux", kind, "simtx-1.0-x86_64.pkg.tar.zst"),
      kind,
    );
  }
  assert(!matchesTarget("app", "linux", "pkg.zst", "simtx-1.0.zst"));
  assert(!matchesTarget("app", "linux", "exe", "setup.exe"));
});

Deno.test("matchesTarget: app/windows excludes standalone CLI", () => {
  assert(matchesTarget("app", "windows", "exe", "SimTX-Setup.exe"));
  assert(!matchesTarget("app", "windows", "exe", "simtx-cli.exe"));
  assert(!matchesTarget("app", "windows", "exe", "SIMTX-CLI.EXE"));
  assert(!matchesTarget("app", "windows", "exe", "app.deb"));
});

Deno.test("matchesTarget: app/macos is dmg only (kind unchecked here)", () => {
  assert(matchesTarget("app", "macos", "dmg", "SimTX.dmg"));
  assert(matchesTarget("app", "macos", "dmg", "simtx.DMG"));
  assert(!matchesTarget("app", "macos", "dmg", "setup.exe"));
  assert(matchesTarget("app", "macos", "exe", "SimTX.dmg"));
});

Deno.test("matchesTarget: cli binaries by exact name", () => {
  for (const os of ["linux", "macos"]) {
    assert(matchesTarget("cli", os, "binary", "simtx-cli"), os);
    assert(matchesTarget("cli", os, "binary", "SIMTX-CLI"), os);
    assert(!matchesTarget("cli", os, "binary", "simtx-cli.exe"), os);
    assert(!matchesTarget("cli", os, "binary", "simtx-1.0.deb"), os);
  }
  assert(matchesTarget("cli", "windows", "binary", "simtx-cli.exe"));
  assert(matchesTarget("cli", "windows", "exe", "simtx-cli.exe"));
  assert(!matchesTarget("cli", "windows", "binary", "simtx-cli"));
  assert(!matchesTarget("cli", "windows", "binary", "Setup.exe"));
});

Deno.test("matchesTarget: unknown os never matches; product checked upstream", () => {
  assert(!matchesTarget("app", "freebsd", "deb", "a.deb"));
  assert(!matchesTarget("cli", "freebsd", "binary", "simtx-cli"));
  assert(matchesTarget("bogus", "linux", "deb", "a.deb"));
});

Deno.test("canonicalKind: full alias matrix", () => {
  const cases: Array<[string, string, string, string | null]> = [
    ["app", "linux", "deb", "deb"],
    ["app", "linux", "appimage", "appimage"],
    ["app", "linux", "rpm", "rpm"],
    ["app", "linux", "pkg.zst", "pkg.zst"],
    ["app", "linux", "pkg.tar.zst", "pkg.zst"],
    ["app", "linux", "arch", "pkg.zst"],
    ["app", "linux", "exe", null],
    ["app", "linux", "dmg", null],
    ["app", "windows", "exe", "exe"],
    ["app", "windows", "deb", null],
    ["app", "windows", "binary", null],
    ["app", "macos", "dmg", "dmg"],
    ["app", "macos", "exe", null],
    ["cli", "linux", "binary", "binary"],
    ["cli", "linux", "exe", null],
    ["cli", "macos", "binary", "binary"],
    ["cli", "macos", "dmg", null],
    ["cli", "windows", "binary", "binary"],
    ["cli", "windows", "exe", "binary"],
    ["cli", "windows", "dmg", null],
    ["bogus", "linux", "deb", null],
    ["app", "freebsd", "deb", null],
  ];
  for (const [product, os, kind, want] of cases) {
    assertEquals(
      canonicalKind(product as Product, os as Os, kind),
      want,
      `${product}/${os}/${kind}`,
    );
  }
});

Deno.test("RefSchema: accepts refs, rejects junk with 422", () => {
  for (
    const ok of ["latest", "v1.2.3", "main", "0.1.0-alpha-1", "a", "x".repeat(128)]
  ) {
    assertEquals(parseOr422(RefSchema, ok), ok.toLowerCase(), ok);
  }
  for (
    const bad of ["", "-lead", ".lead", "bad!ref", "a/b", "has space", "x".repeat(129)]
  ) {
    const err = assertThrows(
      () => parseOr422(RefSchema, bad),
      HttpError,
      undefined,
      JSON.stringify(bad),
    );
    assertEquals((err as HttpError).status, 422, JSON.stringify(bad));
  }
  assertEquals(parseOr422(RefSchema, "V1.0"), "v1.0");
});

Deno.test("runInfo: maps fields, slices sha, falls back title", () => {
  assertEquals(runInfo(null), null);
  const full: Run = {
    id: 42,
    head_branch: "main",
    head_sha: "abcdef1234567890",
    run_number: 9,
    display_title: "PR title",
    name: "workflow",
    html_url: "https://example.com/run",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  };
  const info = runInfo(full)!;
  assertEquals(info.sha, "abcdef1");
  assertEquals(info.full_sha, "abcdef1234567890");
  assertEquals(info.title, "PR title");
  assertEquals(info.built_at, "2026-01-02T00:00:00Z");
  assertEquals(runInfo({ ...full, display_title: "" })!.title, "workflow");
});

Deno.test("text/json helpers: status, content-type, trailing newline", async () => {
  const t = text("hello", 400);
  assertEquals(t.status, 400);
  assertStringIncludes(t.headers.get("content-type")!, "text/plain");
  assertEquals(await t.text(), "hello\n");

  const j = json({ a: 1 });
  assertEquals(j.status, 200);
  assertStringIncludes(j.headers.get("content-type")!, "application/json");
  assertEquals(j.headers.get("cache-control"), "no-cache");
  assertEquals(await j.text(), JSON.stringify({ a: 1 }, null, 2) + "\n");
});
