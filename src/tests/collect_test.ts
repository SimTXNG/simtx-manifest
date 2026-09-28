import { assert, assertEquals } from "@std/assert";
import { strToU8, zipSync } from "fflate";
import { collect } from "../app.ts";

const bin = (s: string) => strToU8(s);

Deno.test("collect: picks wanted files, drops junk, strips dirs", () => {
  const zip = zipSync({
    "dist/simtx-1.0_amd64.deb": bin("deb"),
    "dist/notes.txt": bin("nope"),
    "readme.md": bin("nope"),
  });
  const out = collect(zip);
  assertEquals(Object.keys(out), ["simtx-1.0_amd64.deb"]);
});

Deno.test("collect: extension match is case-insensitive", () => {
  const zip = zipSync({ "SimTX-x86_64.APPIMAGE": bin("img") });
  assert("SimTX-x86_64.APPIMAGE" in collect(zip));
});

Deno.test("collect: extensionless simtx-cli by basename", () => {
  const zip = zipSync({
    "bin/simtx-cli": bin("cli"),
    "bin/other": bin("nope"),
  });
  const out = collect(zip);
  assert("simtx-cli" in out);
  assert(!("other" in out));
});

Deno.test("collect: recurses into double-zipped artifact", () => {
  const inner = zipSync({ "payload/simtx-1.0_amd64.deb": bin("deb") });
  const outer = zipSync({ "artifact.zip": inner, "readme.txt": bin("x") });
  const out = collect(outer);
  assertEquals(Object.keys(out), ["simtx-1.0_amd64.deb"]);
});

Deno.test("collect: depth cap stops very deep nesting", () => {
  const leaf = { "deep/app-1.0_amd64.deb": bin("deb") };
  const l1 = zipSync(leaf);
  const l2 = zipSync({ "mid.zip": l1 });
  const l3 = zipSync({ "outer.zip": l2 });
  assert("app-1.0_amd64.deb" in collect(l3), "3-level nesting");

  const m1 = zipSync(leaf);
  const m2 = zipSync({ "a.zip": m1 });
  const m3 = zipSync({ "b.zip": m2 });
  const m4 = zipSync({ "c.zip": m3 });
  assert(!("app-1.0_amd64.deb" in collect(m4)), "4-level nesting dropped");
});

Deno.test("collect: junk-only zip yields empty set", () => {
  const zip = zipSync({ "notes.txt": bin("x"), "log/output.log": bin("y") });
  assertEquals(collect(zip), {});
});

Deno.test("collect: keeps appimage zsync + sha256 sidecars", () => {
  const zip = zipSync({
    "dist/simtx-x86_64.AppImage": bin("img"),
    "dist/simtx-x86_64.AppImage.zsync": bin("zsync"),
    "dist/simtx-x86_64.AppImage.sha256": bin("hash"),
  });
  const out = collect(zip);
  assert("simtx-x86_64.AppImage" in out);
  assert("simtx-x86_64.AppImage.zsync" in out);
  assert("simtx-x86_64.AppImage.sha256" in out);
});
