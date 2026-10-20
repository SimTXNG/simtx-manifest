import { createApp, type AppOptions } from "../app.ts";
import { uploadTargetDir } from "../uploads.ts";

const FIX = new URL("./fixtures/", import.meta.url);

export async function seedUpload(
  cacheDir: string,
  ref: string,
  product: string,
  os: string,
  arch: string,
  kind: string,
  filename: string,
  data: Uint8Array | string,
): Promise<string> {
  const dir = uploadTargetDir(cacheDir, ref, product, os, arch, kind);
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${filename}`;
  await Deno.writeFile(
    path,
    typeof data === "string" ? new TextEncoder().encode(data) : data,
  );
  return path;
}

export async function seedUploadFixture(
  cacheDir: string,
  ref: string,
  product: string,
  os: string,
  arch: string,
  kind: string,
  filename: string,
): Promise<string> {
  const dir = uploadTargetDir(cacheDir, ref, product, os, arch, kind);
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${filename}`;
  await Deno.copyFile(new URL(filename, FIX), path);
  return path;
}

export function baseOpts(
  cacheDir: string,
  extra: Partial<AppOptions> = {},
): AppOptions {
  return {
    cacheDir,
    tagTtlMs: 300_000,
    targetsTtlMs: 300_000,
    ...extra,
  };
}

export function testCtx(cacheDir: string, extra: Partial<AppOptions> = {}) {
  return createApp(baseOpts(cacheDir, extra));
}

export function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}
