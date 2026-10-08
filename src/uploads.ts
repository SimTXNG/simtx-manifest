import { z } from "zod";
import { sha256Hex } from "./repo-util.ts";
import {
  DownloadParamsSchema,
  HttpError,
  parseOr422,
  RefSchema,
} from "./validation.ts";

// Authenticated direct-upload store (bypasses GitHub Actions).
// Layout: <cacheDir>/uploads/<ref>/<product>/<os>/<arch>/<kind>/<filename>.
// Uploads shadow GitHub artifacts on every read path when present.
//
// Matcher is injected (app.ts owns download matching) so this module has
// no dependency back on app.ts.

export type TargetMatcher = (
  product: string,
  os: string,
  kind: string,
  name: string,
) => boolean;

export interface UploadDeps {
  cacheDir: string;
  uploadToken?: string;
  maxBytes: number;
  matches: TargetMatcher;
  onMutated: (ref: string) => void;
  targets: Array<{
    product: string;
    os: string;
    arch: string;
    kind: string;
  }>;
}

// --- Zod schemas ------------------------------------------------------------

// Charset only; the target-kind match needs product/os/kind context and is
// checked in parseUploadFilename below.
const UploadFilenameSchema = z.string()
  .trim()
  .min(1, "Invalid filename")
  .max(255, "Invalid filename")
  .regex(/^[\w][\w.+~:-]{0,254}$/, "Invalid filename");

const UploadBodySchema = z.instanceof(Uint8Array).refine(
  (b) => b.length > 0,
  { message: "empty upload body" },
);

const UploadAuthSchema = z.string().regex(
  /^Bearer .+$/,
  "missing or malformed Authorization header",
);

export function defaultUploadFilename(
  product: string,
  os: string,
  kind: string,
): string {
  if (product === "cli") {
    return os === "windows" ? "simtx-cli.exe" : "simtx-cli";
  }
  if (os === "windows") return "upload.exe";
  if (os === "macos") return "upload.dmg";
  switch (kind) {
    case "deb":
      return "upload.deb";
    case "rpm":
      return "upload.rpm";
    case "pkg.zst":
      return "upload.pkg.tar.zst";
    case "pkg.zst.sig":
      return "upload.pkg.tar.zst.sig";
    case "appimage":
      return "upload.AppImage";
    case "appimage-zsync":
      return "upload.AppImage.zsync";
    case "appimage-sha256":
      return "upload.AppImage.sha256";
    default:
      return "upload.bin";
  }
}

/// Validate a `?filename=` / `X-Filename` value (422 on failure).
/// Null (no name supplied) falls back to the kind-derived default.
export function parseUploadFilename(
  raw: string | null,
  product: string,
  os: string,
  kind: string,
  matches: TargetMatcher,
): string {
  if (raw === null) return defaultUploadFilename(product, os, kind);
  const name = parseOr422(UploadFilenameSchema, raw);
  if (name === "." || name === "..") {
    throw new HttpError(422, `Invalid filename "${raw}"`);
  }
  if (!matches(product, os, kind, name)) {
    throw new HttpError(
      422,
      `Filename "${name}" does not match ${product}/${os}/${kind}`,
    );
  }
  return name;
}

/// Validate a request body (422 when empty). Size caps stay manual so
/// oversized uploads keep their 413 status.
export function parseUploadBody(buf: Uint8Array): Uint8Array {
  return parseOr422(UploadBodySchema, buf);
}

function timingSafeEqual(a: string, b: string): boolean {
  const ae = new TextEncoder().encode(a);
  const be = new TextEncoder().encode(b);
  if (ae.length !== be.length) return false;
  let diff = 0;
  for (let i = 0; i < ae.length; i++) diff |= ae[i] ^ be[i];
  return diff === 0;
}

/// Bearer-token guard. 503 when uploads are disabled, 401 on auth failure
/// (Zod shapes the header; the status is mapped to 401, not 422).
export function checkUploadAuth(
  request: Request,
  token: string | undefined,
): void {
  if (!token) {
    throw new HttpError(503, "uploads are disabled (UPLOAD_TOKEN unset)");
  }
  const parsed = UploadAuthSchema.safeParse(
    request.headers.get("authorization") ?? "",
  );
  if (!parsed.success) {
    throw new HttpError(401, "missing or malformed Authorization header");
  }
  if (!timingSafeEqual(parsed.data.slice("Bearer ".length), token)) {
    throw new HttpError(401, "invalid upload token");
  }
}

export function uploadFilenameFrom(request: Request): string | null {
  try {
    const q = new URL(request.url).searchParams.get("filename");
    if (q) return q;
  } catch {
    /* ignore */
  }
  return request.headers.get("x-filename");
}

// --- Filesystem store -------------------------------------------------------

export const uploadTargetDir = (
  cacheDir: string,
  ref: string,
  product: string,
  os: string,
  arch: string,
  kind: string,
) => `${cacheDir}/uploads/${ref}/${product}/${os}/${arch}/${kind}`;

export async function findUploadFile(
  cacheDir: string,
  ref: string,
  product: string,
  os: string,
  arch: string,
  kind: string,
  matches: TargetMatcher,
): Promise<string | null> {
  // arch is part of the dir path; matching is on product/os/kind only.
  const dir = uploadTargetDir(cacheDir, ref, product, os, arch, kind);
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) names.push(entry.name);
    }
  } catch {
    return null;
  }
  names.sort((a, b) => a.localeCompare(b));
  return names.find((n) => matches(product, os, kind, n)) ?? null;
}

export async function readUploadFile(
  cacheDir: string,
  ref: string,
  product: string,
  os: string,
  arch: string,
  kind: string,
  matches: TargetMatcher,
): Promise<{ file: string; data: Uint8Array } | null> {
  const file = await findUploadFile(
    cacheDir,
    ref,
    product,
    os,
    arch,
    kind,
    matches,
  );
  if (!file) return null;
  try {
    const data = await Deno.readFile(
      `${uploadTargetDir(cacheDir, ref, product, os, arch, kind)}/${file}`,
    );
    return { file, data };
  } catch {
    return null;
  }
}

export async function storeUploadFile(
  cacheDir: string,
  ref: string,
  product: string,
  os: string,
  arch: string,
  kind: string,
  filename: string,
  data: Uint8Array,
): Promise<void> {
  const dir = uploadTargetDir(cacheDir, ref, product, os, arch, kind);
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${dir}/.${filename}.partial.${crypto.randomUUID()}`;
  try {
    await Deno.writeFile(tmp, data);
    // One file per target: drop stale siblings so reads are deterministic.
    for await (const entry of Deno.readDir(dir)) {
      if (
        entry.isFile && entry.name !== filename && !entry.name.startsWith(".")
      ) {
        await Deno.remove(`${dir}/${entry.name}`).catch(() => {});
      }
    }
    await Deno.rename(tmp, `${dir}/${filename}`);
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
}

/// Remove a whole upload target dir. Returns the matched filenames.
/// Throws 404 when nothing is stored for the target.
export async function deleteUploadTarget(
  cacheDir: string,
  ref: string,
  product: string,
  os: string,
  arch: string,
  kind: string,
  matches: TargetMatcher,
): Promise<string[]> {
  const dir = uploadTargetDir(cacheDir, ref, product, os, arch, kind);
  const entries: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) entries.push(entry.name);
    }
  } catch {
    throw new HttpError(
      404,
      `no upload for ${product}/${os}/${arch}/${kind} at "${ref}"`,
    );
  }
  const match = entries.filter((n) => matches(product, os, kind, n));
  if (match.length === 0) {
    throw new HttpError(
      404,
      `no upload for ${product}/${os}/${arch}/${kind} at "${ref}"`,
    );
  }
  await Deno.remove(dir, { recursive: true });
  return match;
}

// --- Route handlers ---------------------------------------------------------

const uploadJson = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });

export async function handleUpload(
  request: Request,
  refRaw: string,
  productRaw: string,
  osRaw: string,
  archRaw: string,
  kindRaw: string,
  deps: UploadDeps,
): Promise<Response> {
  checkUploadAuth(request, deps.uploadToken);
  const { ref, product, os, arch, kind } = parseOr422(DownloadParamsSchema, {
    ref: refRaw,
    product: productRaw,
    os: osRaw,
    arch: archRaw,
    kind: kindRaw,
  });
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > deps.maxBytes) {
    throw new HttpError(413, `upload exceeds ${deps.maxBytes} bytes`);
  }
  const buf = parseUploadBody(new Uint8Array(await request.arrayBuffer()));
  if (buf.length > deps.maxBytes) {
    throw new HttpError(413, `upload exceeds ${deps.maxBytes} bytes`);
  }
  const filename = parseUploadFilename(
    uploadFilenameFrom(request),
    product,
    os,
    kind,
    deps.matches,
  );
  await storeUploadFile(
    deps.cacheDir,
    ref,
    product,
    os,
    arch,
    kind,
    filename,
    buf,
  );
  deps.onMutated(ref);
  return uploadJson({
    ref,
    product,
    os,
    arch,
    kind,
    file: filename,
    size: buf.length,
    sha256: await sha256Hex(buf),
  }, 201);
}

export async function handleDeleteUpload(
  request: Request,
  refRaw: string,
  productRaw: string,
  osRaw: string,
  archRaw: string,
  kindRaw: string,
  deps: UploadDeps,
): Promise<Response> {
  checkUploadAuth(request, deps.uploadToken);
  const { ref, product, os, arch, kind } = parseOr422(DownloadParamsSchema, {
    ref: refRaw,
    product: productRaw,
    os: osRaw,
    arch: archRaw,
    kind: kindRaw,
  });
  const deleted = await deleteUploadTarget(
    deps.cacheDir,
    ref,
    product,
    os,
    arch,
    kind,
    deps.matches,
  );
  deps.onMutated(ref);
  return uploadJson({ ref, product, os, arch, kind, deleted });
}

export async function handleListUploads(
  request: Request,
  refRaw: string,
  deps: UploadDeps,
): Promise<Response> {
  checkUploadAuth(request, deps.uploadToken);
  const ref = parseOr422(RefSchema, refRaw);
  const out: Array<Record<string, unknown>> = [];
  for (const t of deps.targets) {
    const dir = uploadTargetDir(
      deps.cacheDir,
      ref,
      t.product,
      t.os,
      t.arch,
      t.kind,
    );
    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile) names.push(entry.name);
      }
    } catch {
      continue;
    }
    for (
      const file of names.filter((n) =>
        deps.matches(t.product, t.os, t.kind, n)
      )
    ) {
      let size: number | null = null;
      try {
        size = (await Deno.stat(`${dir}/${file}`)).size;
      } catch {
        /* ignore */
      }
      out.push({
        ...t,
        file,
        size,
        url: `/${ref}/${t.product}/${t.os}/${t.arch}/${t.kind}`,
      });
    }
  }
  return uploadJson({ ref, uploads: out });
}
