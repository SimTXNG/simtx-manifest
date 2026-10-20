import { Elysia } from "elysia";
import type { z } from "zod";
import { unzipSync } from "fflate";
import { archPackageForBytes, buildArchDb } from "./repo-arch.ts";
import {
  buildFilelistsXml,
  buildOtherXml,
  buildPrimaryXml,
  buildRepomdXml,
  parseRpm,
} from "./repo-rpm.ts";
import {
  APT_COMPONENT,
  APT_SUITE,
  buildRelease,
  debControlAsync,
  debFileName,
  hashFile,
  packagesEntry,
} from "./repo-apt.ts";
import { clearSign, detachSign, loadSigningKey } from "./repo-sign.ts";
import {
  buildXbpsRepo,
  loadXbpsSigningKey,
  parseXbpsPackage,
  XBPS_REPODATA,
} from "./repo-xbps.ts";
import type { XbpsSigner } from "./repo-xbps.ts";
import { gzipBytes, sha256Hex } from "./repo-util.ts";
import {
  findUploadFile,
  handleDeleteUpload,
  handleListUploads,
  handleUpload,
  readUploadFile,
  uploadTargetDir,
} from "./uploads.ts";
import {
  AppOptionsSchema,
  ArtifactsSchema,
  DownloadParamsSchema,
  HttpError,
  parseOr422,
  RefSchema,
  RunListSchema,
  TagsSchema,
  TargetDefSchema,
} from "./validation.ts";
import type {
  AppOptions as ValidatedOptions,
  Os,
  Run,
  RunList,
  TargetDef,
} from "./validation.ts";

export { HttpError };
export type { Run, RunList, TargetDef };
export const WANTED_EXTS = [
  ".deb",
  ".appimage",
  ".appimage.zsync",
  ".appimage.sha256",
  ".sha256",
  ".pkg.tar.zst.sig",
  ".sig",
  ".exe",
  ".rpm",
  ".xbps",
  ".pkg.tar.zst",
  ".dmg",
];
export const CLI_UNIX_NAMES = ["simtx-cli"];
export const CLI_WINDOWS_NAMES = ["simtx-cli.exe"];

export const isCliUnix = (n: string) =>
  CLI_UNIX_NAMES.includes(n.toLowerCase());
export const isCliWindows = (n: string) =>
  CLI_WINDOWS_NAMES.includes(n.toLowerCase());

export function matchesTarget(
  product: string,
  os: string,
  kind: string,
  name: string,
): boolean {
  const n = name.toLowerCase();
  if (product === "cli") {
    if (os === "linux" || os === "macos") return isCliUnix(n);
    if (os === "windows") return isCliWindows(n);
    return false;
  }
  if (os === "linux") {
    if (kind === "deb") return n.endsWith(".deb");
    if (kind === "pkg.zst.sig") return n.endsWith(".pkg.tar.zst.sig");
    if (kind === "appimage") {
      return (
        n.endsWith(".appimage") &&
        !n.endsWith(".appimage.zsync") &&
        !n.endsWith(".appimage.sha256")
      );
    }
    if (kind === "appimage-zsync") return n.endsWith(".appimage.zsync");
    if (kind === "appimage-sha256") {
      return (
        n.endsWith(".appimage.sha256") ||
        (n.endsWith(".sha256") && n.includes(".appimage"))
      );
    }
    if (kind === "rpm") return n.endsWith(".rpm");
    if (kind === "xbps") return n.endsWith(".xbps");
    if (kind === "pkg.zst" || kind === "pkg.tar.zst" || kind === "arch") {
      return n.endsWith(".pkg.tar.zst");
    }
    return false;
  }
  if (os === "windows") {
    return n.endsWith(".exe") && !isCliWindows(n);
  }
  if (os === "macos") {
    return n.endsWith(".dmg");
  }
  return false;
}

export const text = (body: string, status = 200) =>
  new Response(body + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

export function stripLeadingV(tag: string): string {
  const t = tag.trim();
  if (t.length > 1 && (t[0] === "v" || t[0] === "V")) return t.slice(1);
  return t;
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });

export function runInfo(run: Run | null) {
  if (!run) return null;
  return {
    id: run.id,
    branch: run.head_branch,
    sha: run.head_sha?.slice(0, 7) ?? null,
    full_sha: run.head_sha ?? null,
    run_number: run.run_number,
    title: run.display_title || run.name,
    url: run.html_url,
    created_at: run.created_at,
    built_at: run.updated_at,
  };
}

export const TARGET_DEFS: TargetDef[] = TargetDefSchema.array().parse([
  { product: "app", os: "linux", arch: "amd64", kind: "deb" },
  { product: "app", os: "linux", arch: "amd64", kind: "rpm" },
  { product: "app", os: "linux", arch: "amd64", kind: "xbps" },
  { product: "app", os: "linux", arch: "amd64", kind: "pkg.zst" },
  { product: "app", os: "linux", arch: "amd64", kind: "pkg.zst.sig" },
  { product: "app", os: "linux", arch: "amd64", kind: "appimage" },
  { product: "app", os: "linux", arch: "amd64", kind: "appimage-zsync" },
  { product: "app", os: "linux", arch: "amd64", kind: "appimage-sha256" },
  { product: "app", os: "windows", arch: "amd64", kind: "exe" },
  { product: "app", os: "macos", arch: "arm64", kind: "dmg" },
  { product: "cli", os: "linux", arch: "amd64", kind: "binary" },
  { product: "cli", os: "windows", arch: "amd64", kind: "binary" },
  { product: "cli", os: "macos", arch: "arm64", kind: "binary" },
]);

export function collect(
  zip: Uint8Array,
  out: Record<string, Uint8Array> = {},
  depth = 0,
) {
  const entries = unzipSync(zip, {
    filter: (f) => {
      const n = f.name.toLowerCase();
      return (
        n.endsWith(".zip") ||
        WANTED_EXTS.some((e) => n.endsWith(e)) ||
        isCliUnix(n.split("/").pop() ?? "")
      );
    },
  });
  for (const [path, data] of Object.entries(entries)) {
    const name = path.split("/").pop();
    if (!name) continue;
    if (name.toLowerCase().endsWith(".zip")) {
      if (depth < 2) collect(data, out, depth + 1);
    } else {
      out[name] = data;
    }
  }
  return out;
}

export type AppOptions = ValidatedOptions & {
  indexFileUrl?: URL | string;
  fetchImpl?: typeof fetch;
  // Test-only override for the expected signing fingerprint (the schema
  // strips it, so it is read from opts, never from validated config).
  signingKeyFpr?: string;
};

// Direct-upload store + handlers live in ./uploads.ts (Zod-validated).
// Uploads shadow GitHub artifacts on every read path when present.

// Repo hosting (APT + Arch) signs metadata with the package-signing key.
// Unsigned mode serves packages but answers 503 on all repo-metadata
// routes: never ship unverifiable metadata.
const REPO_TTL_MS = 60_000;

export function createApp(opts: AppOptions) {
  const cfg = parseOr422(AppOptionsSchema, opts);
  const REPO = cfg.repo;
  const TOKEN = cfg.token;
  const WORKFLOWS = cfg.workflows;
  const CACHE_DIR = cfg.cacheDir;
  const LATEST_TTL = cfg.latestTtlMs;
  const TAG_TTL = cfg.tagTtlMs;
  const TARGETS_TTL = cfg.targetsTtlMs;
  const CACHE_MAX_RUNS = cfg.cacheMaxRuns;
  const LATEST_REF = cfg.latestRef;
  const VERSION_RETURN = cfg.versionReturn?.trim() || undefined;
  const UPLOAD_TOKEN = cfg.uploadToken?.trim() || undefined;
  const UPLOAD_MAX_BYTES = cfg.uploadMaxBytes ?? 524_288_000;
  const XBPS_SIGNING_KEY = cfg.xbpsSigningKey?.trim() || undefined;
  const XBPS_SIGNED_BY = cfg.xbpsSignedBy?.trim() ||
    "SimTX XBPS Repository <packages@simtx.net>";
  const XBPS_PASSPHRASE = cfg.xbpsPassphrase;
  const INDEX_URL =
    opts.indexFileUrl ?? new URL("./static/index.html", import.meta.url);

  let fetchFn: typeof fetch = opts.fetchImpl ?? fetch;
  const runCache = new Map<string, { run: Run | null; expires: number }>();
  const targetsCache = new Map<string, { data: unknown; expires: number }>();
  const inflight = new Map<number, Promise<string>>();
  let cachedIndex: Uint8Array | null = null;
  let cachedVersion: { value: string; expires: number } | null = null;

  const gh = (path: string, init: RequestInit = {}) =>
    fetchFn(`https://api.github.com/repos/${REPO}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "simtx-manifest",
        ...init.headers,
      },
    });

  async function ghJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const res = await gh(path);
    if (!res.ok) {
      await res.body?.cancel();
      throw new HttpError(502, `GitHub API returned ${res.status} for ${path}`);
    }
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) {
      throw new HttpError(
        502,
        `GitHub API returned malformed data for ${path}`,
      );
    }
    return parsed.data;
  }

  // Upload wiring: ./uploads.ts owns the store + handlers (Zod-validated);
  // app-side caches are invalidated through onMutated.
  function invalidateUploadCaches(ref: string): void {
    targetsCache.delete(ref);
    aptCache = null;
    archCache = null;
    rpmCache = null;
    xbpsCache = null;
  }

  const uploadDeps = {
    cacheDir: CACHE_DIR,
    uploadToken: UPLOAD_TOKEN,
    maxBytes: UPLOAD_MAX_BYTES,
    matches: matchesTarget,
    onMutated: invalidateUploadCaches,
    targets: TARGET_DEFS,
  };
  const findUpload = (
    ref: string,
    product: string,
    os: string,
    arch: string,
    kind: string,
  ) => findUploadFile(CACHE_DIR, ref, product, os, arch, kind, matchesTarget);
  const readUpload = (
    ref: string,
    product: string,
    os: string,
    arch: string,
    kind: string,
  ) => readUploadFile(CACHE_DIR, ref, product, os, arch, kind, matchesTarget);
  const uploadPath = (
    ref: string,
    product: string,
    os: string,
    arch: string,
    kind: string,
    file: string,
  ) => `${uploadTargetDir(CACHE_DIR, ref, product, os, arch, kind)}/${file}`;

  async function latestTagVersion(): Promise<string> {
    if (cachedVersion && cachedVersion.expires > Date.now()) {
      return cachedVersion.value;
    }
    let tags;
    try {
      tags = await ghJson(`/tags?per_page=100`, TagsSchema);
    } catch (e) {
      if (e instanceof HttpError && e.status === 503) throw e;
      throw new HttpError(
        503,
        `VERSION_RETURN is not configured and tag lookup failed: ${(e as Error).message}`,
      );
    }
    const name = tags[0]?.name?.trim();
    if (!name) {
      throw new HttpError(
        503,
        "VERSION_RETURN is not configured and no tags found",
      );
    }
    const value = stripLeadingV(name);
    if (!value) {
      throw new HttpError(
        503,
        "VERSION_RETURN is not configured and no tags found",
      );
    }
    cachedVersion = { value, expires: Date.now() + TAG_TTL };
    return value;
  }

  function resolveVersion(): Promise<string> {
    if (VERSION_RETURN) return Promise.resolve(VERSION_RETURN);
    return latestTagVersion();
  }

  async function latestStatus() {
    const [linuxRun, windowsRun, macosRun, version] = await Promise.all([
      resolveRun(WORKFLOWS.linux, "latest"),
      resolveRun(WORKFLOWS.windows, "latest"),
      resolveRun(WORKFLOWS.macos, "latest"),
      resolveVersion(),
    ]);
    const linux = runInfo(linuxRun);
    const windows = runInfo(windowsRun);
    const macos = runInfo(macosRun);
    const times = [linux?.built_at, windows?.built_at, macos?.built_at].filter(
      Boolean,
    ) as string[];
    const newest = times.sort().at(-1) ?? null;
    return {
      version,
      repo: REPO,
      newest_built_at: newest,
      linux,
      windows,
      macos,
    };
  }

  async function buildTargets(ref: string) {
    const oss = Object.keys(WORKFLOWS) as Os[];
    const [version, runs] = await Promise.all([
      resolveVersion(),
      Promise.all(
        oss.map(async (os) => ({
          os,
          run: await resolveRun(WORKFLOWS[os], ref),
        })),
      ),
    ]);
    const targets = await Promise.all(
      TARGET_DEFS.map(async (t) => {
        const base = {
          ...t,
          url: `/${ref}/${t.product}/${t.os}/${t.arch}/${t.kind}`,
        };
        // Uploads shadow GitHub artifacts.
        const upFile = await findUpload(ref, t.product, t.os, t.arch, t.kind);
        if (upFile) {
          try {
            const { size } = await Deno.stat(
              uploadPath(ref, t.product, t.os, t.arch, t.kind, upFile),
            );
            return {
              ...base,
              available: true,
              file: upFile,
              size,
              reason: null,
            };
          } catch {
            /* fall through to GitHub */
          }
        }
        const run = runs.find((r) => r.os === t.os)?.run ?? null;
        if (!run) {
          return {
            ...base,
            available: false,
            file: null,
            size: null,
            reason: "no successful build",
          };
        }
        const names: string[] = [];
        try {
          const dir = await ensureExtracted(run.id);
          for await (const entry of Deno.readDir(dir)) {
            if (entry.isFile) names.push(entry.name);
          }
        } catch (e) {
          return {
            ...base,
            available: false,
            file: null,
            size: null,
            reason: (e as Error).message,
          };
        }
        const file = names
          .filter((n) => matchesTarget(t.product, t.os, t.kind, n))
          .sort((a, b) => a.localeCompare(b))[0];
        if (!file) {
          return {
            ...base,
            available: false,
            file: null,
            size: null,
            reason: "file missing from artifact",
          };
        }
        const { size } = await Deno.stat(`${CACHE_DIR}/${run.id}/${file}`);
        return { ...base, available: true, file, size, reason: null };
      }),
    );
    return {
      ref,
      version,
      stale: false,
      targets,
    };
  }

  async function getTargets(ref: string) {
    const hit = targetsCache.get(ref);
    if (hit && hit.expires > Date.now()) return hit.data;
    try {
      const data = await buildTargets(ref);
      targetsCache.set(ref, { data, expires: Date.now() + TARGETS_TTL });
      return data;
    } catch (e) {
      if (hit) return { ...(hit.data as Record<string, unknown>), stale: true };
      throw e;
    }
  }

  async function servePubkey(): Promise<Response> {
    // Package-signing public key (ed25519, packages@simtx.net).
    // Static file: cache hard, rotate by committing a new filename.
    const raw = await Deno.readFile(
      new URL("./static/simtx-signing-pubkey.asc", import.meta.url),
    );
    const bytes = new Uint8Array(raw);
    return new Response(bytes, {
      headers: {
        "content-type": "application/pgp-keys",
        "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename="simtx-signing-pubkey.asc"`,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  async function serveIndex(): Promise<Response> {
    try {
      cachedIndex = await Deno.readFile(INDEX_URL);
    } catch {
      if (!cachedIndex) throw new HttpError(404, "index.html not found");
    }
    return new Response(cachedIndex as unknown as BodyInit, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  }

  async function serveInstall(): Promise<Response> {
    let raw: Uint8Array;
    try {
      raw = await Deno.readFile(
        new URL("./static/install.html", import.meta.url),
      );
    } catch {
      throw new HttpError(404, "install.html not found");
    }
    return new Response(raw as unknown as BodyInit, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  }

  async function findRun(workflow: string, ref: string): Promise<Run | null> {
    const wf = encodeURIComponent(workflow);
    const branch = ref === "latest" ? LATEST_REF : ref;

    const filter = branch ? `&branch=${encodeURIComponent(branch)}` : "";
    const { workflow_runs } = await ghJson(
      `/actions/workflows/${wf}/runs?status=success&per_page=1${filter}`,
      RunListSchema,
    );
    return workflow_runs[0] ?? null;
  }

  async function resolveRun(
    workflow: string,
    ref: string,
  ): Promise<Run | null> {
    const key = `${workflow}@${ref}`;
    const hit = runCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.run;
    const run = await findRun(workflow, ref);
    runCache.set(key, {
      run,
      expires: Date.now() + (ref === "latest" ? LATEST_TTL : TAG_TTL),
    });
    return run;
  }

  async function downloadArtifact(id: number): Promise<Uint8Array> {
    let res = await gh(`/actions/artifacts/${id}/zip`, { redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      res = await fetchFn(location);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new HttpError(502, `Artifact download failed (${res.status})`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  function ensureExtracted(runId: number): Promise<string> {
    let p = inflight.get(runId);
    if (!p) {
      p = extract(runId).finally(() => inflight.delete(runId));
      inflight.set(runId, p);
    }
    return p;
  }

  async function extract(runId: number): Promise<string> {
    const dir = `${CACHE_DIR}/${runId}`;
    const cached = await Deno.stat(dir)
      .then(() => true)
      .catch(() => false);
    if (cached) return dir;

    const { artifacts } = await ghJson(
      `/actions/runs/${runId}/artifacts`,
      ArtifactsSchema,
    );
    const artifact = artifacts.find((a) => !a.expired);
    if (!artifact) {
      throw new HttpError(410, "Artifact expired or missing for this build");
    }

    const files = collect(await downloadArtifact(artifact.id));
    if (Object.keys(files).length === 0) {
      throw new HttpError(
        502,
        "Artifact contained no .deb/.rpm/.xbps/.pkg.tar.zst/.AppImage/.exe/simtx-cli files",
      );
    }

    const partial = `${dir}.partial`;
    await Deno.remove(partial, { recursive: true }).catch(() => {});
    await Deno.mkdir(partial, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
      await Deno.writeFile(`${partial}/${name}`, data);
    }
    await Deno.rename(partial, dir);
    return dir;
  }

  async function prefetchLatest(reason: string): Promise<void> {
    const jobs = Object.entries(WORKFLOWS).map(async ([os, workflow]) => {
      try {
        const run = await resolveRun(workflow, "latest");
        if (!run) {
          console.log(`[prefetch:${reason}] no successful ${os} build found`);
          return;
        }
        await ensureExtracted(run.id);
        console.log(`[prefetch:${reason}] warmed ${os} run ${run.id}`);
      } catch (e) {
        console.error(
          `[prefetch:${reason}] ${os} failed:`,
          (e as Error).message,
        );
      }
    });
    await Promise.all(jobs);
    if (CACHE_MAX_RUNS > 0) {
      try {
        await pruneCache();
      } catch (e) {
        console.error("[prune] failed:", (e as Error).message);
      }
    }
  }

  async function pruneCache(): Promise<void> {
    if (CACHE_MAX_RUNS <= 0) return;
    const entries: { name: string; mtime: number }[] = [];
    for await (const entry of Deno.readDir(CACHE_DIR)) {
      if (!entry.isDirectory || entry.name.endsWith(".partial")) continue;
      if (!/^\d+$/.test(entry.name)) continue;
      const mtime =
        (await Deno.stat(`${CACHE_DIR}/${entry.name}`)).mtime?.getTime() ?? 0;
      entries.push({ name: entry.name, mtime });
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    for (const stale of entries.slice(CACHE_MAX_RUNS)) {
      await Deno.remove(`${CACHE_DIR}/${stale.name}`, { recursive: true });
      console.log(`[prune] removed cached run ${stale.name}`);
    }
  }

  function parseRange(
    header: string | null,
    size: number,
  ): { start: number; end: number } | null | "invalid" {
    if (!header) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m) return "invalid";
    let start: number;
    let end: number;
    if (m[1] === "" && m[2] === "") return "invalid";
    if (m[1] === "") {
      const suffix = Number(m[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === "" ? size - 1 : Number(m[2]);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start >= size ||
        end >= size ||
        start > end
      )
        return "invalid";
    }
    return { start, end };
  }

  async function latestUpdateInfo() {
    const version = await resolveVersion();
    // Uploads shadow GitHub artifacts for the rolling "latest" AppImage feed.
    const upAppimage = await findUpload(
      "latest",
      "app",
      "linux",
      "amd64",
      "appimage",
    );
    const upZsync = await findUpload(
      "latest",
      "app",
      "linux",
      "amd64",
      "appimage-zsync",
    );
    const upShaFile = await findUpload(
      "latest",
      "app",
      "linux",
      "amd64",
      "appimage-sha256",
    );
    if (upAppimage) {
      const shaDir = uploadTargetDir(
        CACHE_DIR,
        "latest",
        "app",
        "linux",
        "amd64",
        "appimage-sha256",
      );
      let sha256: string | null = null;
      if (upShaFile) {
        try {
          const raw = (
            await Deno.readTextFile(`${shaDir}/${upShaFile}`)
          ).trim().split(/\s+/)[0] ?? "";
          sha256 = /^[0-9a-fA-F]{64}$/.test(raw) ? raw.toLowerCase() : null;
        } catch {
          /* ignore */
        }
      }
      const url = (kind: string) => `/latest/app/linux/amd64/${kind}`;
      return {
        version,
        ref: "latest",
        built_at: null,
        appimage: upAppimage,
        appimage_url: url("appimage"),
        zsync: upZsync,
        zsync_url: upZsync ? url("appimage-zsync") : null,
        sha256_file: upShaFile,
        sha256_url: upShaFile ? url("appimage-sha256") : null,
        sha256,
      };
    }
    const run = await resolveRun(WORKFLOWS.linux, "latest");
    if (!run) throw new HttpError(404, "No successful linux build found");
    const dir = await ensureExtracted(run.id);
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) names.push(entry.name);
    }
    names.sort((a, b) => a.localeCompare(b));
    const appimage =
      names.find((n) => matchesTarget("app", "linux", "appimage", n)) ?? null;
    const zsync =
      names.find((n) => matchesTarget("app", "linux", "appimage-zsync", n)) ??
      null;
    const shaFile =
      names.find((n) => matchesTarget("app", "linux", "appimage-sha256", n)) ??
      null;
    let sha256: string | null = null;
    if (shaFile) {
      const raw =
        (await Deno.readTextFile(`${dir}/${shaFile}`)).trim().split(/\s+/)[0] ??
        "";
      sha256 = /^[0-9a-fA-F]{64}$/.test(raw) ? raw.toLowerCase() : null;
    }
    const ref = run.head_branch;
    const url = (kind: string) => `/${ref}/app/linux/amd64/${kind}`;
    return {
      version,
      ref,
      built_at: run.updated_at,
      appimage: appimage,
      appimage_url: appimage ? url("appimage") : null,
      zsync: zsync,
      zsync_url: zsync ? url("appimage-zsync") : null,
      sha256_file: shaFile,
      sha256_url: shaFile ? url("appimage-sha256") : null,
      sha256,
    };
  }

  async function serveDownload(
    refRaw: string,
    productRaw: string,
    osRaw: string,
    archRaw: string,
    kindRaw: string,
    isHead: boolean,
    rangeHeader: string | null = null,
  ): Promise<Response> {
    const { ref, product, os, arch, kind } = parseOr422(DownloadParamsSchema, {
      ref: refRaw,
      product: productRaw,
      os: osRaw,
      arch: archRaw,
      kind: kindRaw,
    });
    // Uploads shadow GitHub artifacts.
    const upFile = await findUpload(ref, product, os, arch, kind);
    if (upFile) {
      const upPath = uploadPath(ref, product, os, arch, kind, upFile);
      const upSize = (await Deno.stat(upPath)).size;
      const upCacheControl =
        ref === "latest" ? "no-cache" : "public, max-age=31536000, immutable";
      const upHeaders = {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${upFile}"`,
        "X-Release-Ref": ref,
        "Cache-Control": upCacheControl,
        "Accept-Ranges": "bytes",
      };
      if (isHead) {
        return new Response(null, {
          headers: { ...upHeaders, "Content-Length": String(upSize) },
        });
      }
      const upRange = parseRange(rangeHeader, upSize);
      if (upRange === "invalid") {
        return new Response("Range not satisfiable\n", {
          status: 416,
          headers: {
            ...upHeaders,
            "Content-Range": `bytes */${upSize}`,
            "content-type": "text/plain; charset=utf-8",
          },
        });
      }
      if (upRange) {
        const len = upRange.end - upRange.start + 1;
        const data = (await Deno.readFile(upPath)).slice(upRange.start, upRange.end + 1);
        return new Response(data, {
          status: 206,
          headers: {
            ...upHeaders,
            "Content-Length": String(len),
            "Content-Range": `bytes ${upRange.start}-${upRange.end}/${upSize}`,
          },
        });
      }
      const upHeadersFull = new Headers({ ...upHeaders, "Content-Length": String(upSize) });
      return new Response((await Deno.open(upPath)).readable, { headers: upHeadersFull });
    }
    const workflow = WORKFLOWS[os];

    const run = await resolveRun(workflow, ref);
    if (!run) {
      throw new HttpError(404, `No successful ${os} build found for "${ref}"`);
    }

    const dir = await ensureExtracted(run.id);
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) names.push(entry.name);
    }
    names.sort((a, b) => a.localeCompare(b));
    const file = names.find((n) => matchesTarget(product, os, kind, n));
    if (!file) {
      throw new HttpError(
        404,
        `No ${kind} (${product}/${os}) in the ${ref} artifact`,
      );
    }

    const path = `${dir}/${file}`;
    const { size } = await Deno.stat(path);
    const cacheControl =
      ref === "latest" ? "no-cache" : "public, max-age=31536000, immutable";
    const baseHeaders = {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${file}"`,
      "X-Release-Ref": run.head_branch,
      "Cache-Control": cacheControl,
      "Accept-Ranges": "bytes",
    };
    if (isHead) {
      return new Response(null, {
        headers: { ...baseHeaders, "Content-Length": String(size) },
      });
    }
    const range = parseRange(rangeHeader, size);
    if (range === "invalid") {
      return new Response("Range not satisfiable\n", {
        status: 416,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes */${size}`,
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }
    if (range) {
      const len = range.end - range.start + 1;
      const data = (await Deno.readFile(path)).slice(
        range.start,
        range.end + 1,
      );
      return new Response(data, {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Length": String(len),
          "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        },
      });
    }
    const headers = new Headers({
      ...baseHeaders,
      "Content-Length": String(size),
    });
    return new Response((await Deno.open(path)).readable, { headers });
  }

  async function handleTargets(refRaw: string): Promise<Response> {
    const ref = parseOr422(RefSchema, refRaw);
    return json(await getTargets(ref));
  }

  // --- RPM repo (/rpmrepo/...) --------------------------------------------------
  // Rolling repo over the latest successful linux build. Filenames are
  // conventional (<name>-<ver>-<rel>.<arch>.rpm); signatures are
  // embedded in the rpm itself (rpmsign in CI), repomd.xml carries a
  // detached .asc for repo_gpgcheck.

  interface RpmRepo {
    rpmName: string;
    checksum: string;
    primary: Uint8Array;
    filelists: Uint8Array;
    other: Uint8Array;
    repomd: string;
    repomdAsc: string;
  }
  let rpmCache: { key: string; repo: RpmRepo } | null = null;

  const rpmFileName = (info: {
    name: string;
    version: string;
    release: string;
    arch: string;
  }) => `${info.name}-${info.version}-${info.release}.${info.arch}.rpm`;

  async function rpmRepo(): Promise<RpmRepo> {
    // Signing first: unsigned servers answer 503 even with no builds.
    const k = await signKey();
    const pkg = await readRunFile("linux", "latest", "app", "rpm");

    const pkgHash = await sha256Hex(pkg.data);
    const key = `${pkg.file}:${pkgHash}`;
    if (rpmCache && rpmCache.key === key) return rpmCache.repo;
    const info = parseRpm(pkg.data);
    if (!info.name || !info.version || !info.release || !info.arch) {
      throw new HttpError(
        502,
        "rpm repo: header missing name/version/release/arch",
      );
    }
    const rpmName = rpmFileName(info);
    const checksum = pkgHash;
    const enc = new TextEncoder();
    const now = Math.floor(Date.now() / 1000);
    const location = rpmName;
    const primaryRaw = enc.encode(
      buildPrimaryXml([
        {
          info,
          checksum,
          location,
          size: pkg.data.length,
          buildTime: info.buildtime || String(now),
          fileTime: String(now),
        },
      ]),
    );
    const filelistsRaw = enc.encode(buildFilelistsXml([{ info, checksum }]));
    const otherRaw = enc.encode(buildOtherXml([{ info, checksum }]));
    const gz = async (d: Uint8Array) => await gzipBytes(d);
    const [primary, filelists, other] = await Promise.all([
      gz(primaryRaw),
      gz(filelistsRaw),
      gz(otherRaw),
    ]);
    const meta = async (kind: string, raw: Uint8Array, comp: Uint8Array) => ({
      type: kind,
      href: `repodata/${kind}.xml.gz`,
      checksum: await sha256Hex(comp),
      openChecksum: await sha256Hex(raw),
      size: comp.length,
      openSize: raw.length,
      timestamp: String(now),
    });
    const repomd = buildRepomdXml(String(now), [
      await meta("primary", primaryRaw, primary),
      await meta("filelists", filelistsRaw, filelists),
      await meta("other", otherRaw, other),
    ]);
    const repomdAsc = await detachSign(k, enc.encode(repomd));
    const repo = {
      rpmName,
      checksum,
      primary,
      filelists,
      other,
      repomd,
      repomdAsc,
    };
    rpmCache = { key, repo };
    return repo;
  }

  async function serveRpmRepo(
    file: string,
    isHead: boolean,
  ): Promise<Response> {
    const repo = await rpmRepo();
    let body: Uint8Array | string;
    let name: string;
    let ctype = "application/octet-stream";
    if (file === "repomd.xml") {
      body = repo.repomd;
      name = "repomd.xml";
      ctype = "text/xml; charset=utf-8";
    } else if (file === "repomd.xml.asc") {
      body = repo.repomdAsc;
      name = "repomd.xml.asc";
      ctype = "application/pgp-signature";
    } else if (file === "primary.xml.gz") {
      body = repo.primary;
      name = "primary.xml.gz";
    } else if (file === "filelists.xml.gz") {
      body = repo.filelists;
      name = "filelists.xml.gz";
    } else if (file === "other.xml.gz") {
      body = repo.other;
      name = "other.xml.gz";
    } else {
      throw new HttpError(404, "unknown repodata file");
    }
    const bytes =
      typeof body === "string" ? new TextEncoder().encode(body) : body;
    if (isHead) {
      return new Response(null, {
        headers: {
          "Content-Type": ctype,
          "Content-Length": String(bytes.length),
          ...noCache,
        },
      });
    }
    return new Response(u8body(bytes), {
      headers: {
        "Content-Type": ctype,
        "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename="${name}"`,
        ...noCache,
      },
    });
  }

  async function serveRpmPool(
    filename: string,
    isHead: boolean,
  ): Promise<Response> {
    // Signing first: unsigned servers answer 503 even with no builds.
    await signKey();
    if (!/^[\w][\w.+~:-]*\.rpm$/.test(filename)) {
      throw new HttpError(404, "unknown pool file");
    }
    const pkg = await readRunFile("linux", "latest", "app", "rpm");
    let repo = await rpmRepo();
    if (filename !== repo.rpmName) {
      throw new HttpError(404, `pool has no ${filename}`);
    }

    if ((await sha256Hex(pkg.data)) !== repo.checksum) {
      rpmCache = null;
      repo = await rpmRepo();
      if (filename !== repo.rpmName) {
        throw new HttpError(404, `pool has no ${filename}`);
      }
    }
    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(pkg.data.length),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Release-Ref": pkg.run.head_branch,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Accept-Ranges": "bytes",
    };
    if (isHead) return new Response(null, { headers });
    return new Response(u8body(pkg.data), { headers });
  }

  // --- repo hosting (APT + Arch) --------------------------------------------

  const SIGNING_KEY = cfg.signingKey?.trim() || undefined;
  const SIGNING_FPR = opts.signingKeyFpr;
  let signKeyP: Promise<Awaited<ReturnType<typeof loadSigningKey>>> | null =
    null;
  function signKey() {
    if (!SIGNING_KEY) {
      throw new HttpError(
        503,
        "repository signing is not configured (SIGNING_KEY_FILE unset)",
      );
    }
    if (!signKeyP) {
      signKeyP = loadSigningKey(SIGNING_KEY, SIGNING_FPR).catch((e) => {
        signKeyP = null;
        throw new HttpError(
          503,
          `signing key invalid: ${(e as Error).message}`,
        );
      });
    }
    return signKeyP;
  }

  async function readRunFile(
    os: Os,
    ref: string,
    product: string,
    kind: string,
    arch: string = os === "macos" ? "arm64" : "amd64",
  ) {
    // Uploads shadow GitHub artifacts.
    const up = await readUpload(ref, product, os, arch, kind);
    if (up) {
      return { run: { head_branch: ref } as Run, file: up.file, data: up.data };
    }
    const run = await resolveRun(WORKFLOWS[os], ref);
    if (!run) {
      throw new HttpError(404, `No successful ${os} build found for "${ref}"`);
    }
    const dir = await ensureExtracted(run.id);
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) names.push(entry.name);
    }
    names.sort((a, b) => a.localeCompare(b));
    const file = names.find((n) => matchesTarget(product, os, kind, n));
    if (!file) {
      throw new HttpError(
        404,
        `No ${kind} (${product}/${os}) in the ${ref} artifact`,
      );
    }
    return { run, file, data: await Deno.readFile(`${dir}/${file}`) };
  }

  const noCache = { "Cache-Control": "no-cache" };

  // Response bodies as Blob dodge Uint8Array<ArrayBufferLike> typing.
  const u8body = (b: Uint8Array) => new Blob([b as unknown as BlobPart]);

  // -- Arch (/arch/<arch>/simtx.{db,files}[.tar.gz][.sig] + *.pkg.tar.zst[.sig]) --
  // Rolling repo over the latest successful linux build. DB filenames are
  // metadata; package filenames are the pool (same prefix pacman uses).

  interface ArchRepo {
    db: Uint8Array;
    files: Uint8Array;
    dbSig: string;
    filesSig: string;
  }
  let archCache: { key: string; repo: ArchRepo } | null = null;

  async function archRepo(): Promise<ArchRepo> {
    // Signing first: unsigned servers answer 503 even with no builds.
    const k = await signKey();
    const pkg = await readRunFile("linux", "latest", "app", "pkg.zst");
    let sig: Uint8Array | undefined;
    try {
      sig = (await readRunFile("linux", "latest", "app", "pkg.zst.sig")).data;
    } catch (e) {
      if (!(e instanceof HttpError) || (e as HttpError).status !== 404) throw e;
    }
    const pkgHash = await sha256Hex(pkg.data);
    const sigHash = sig ? await sha256Hex(sig) : "";
    const key = `${pkg.file}:${pkgHash}:${sigHash}`;
    if (archCache && archCache.key === key) return archCache.repo;
    const ap = await archPackageForBytes(pkg.file, pkg.data, sig);
    if (ap.arch !== "x86_64") {
      throw new HttpError(502, `arch repo: unexpected package arch ${ap.arch}`);
    }
    const { db, files } = await buildArchDb([ap]);
    const [dbSig, filesSig] = await Promise.all([
      detachSign(k, db),
      detachSign(k, files),
    ]);
    const repo = { db, files, dbSig, filesSig };
    archCache = { key, repo };
    return repo;
  }

  const archDb = (body: Uint8Array, name: string) =>
    new Response(u8body(body), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
        "Content-Disposition": `attachment; filename="${name}"`,
        ...noCache,
      },
    });

  async function serveArchDb(kind: string, isHead: boolean): Promise<Response> {
    const repo = await archRepo();
    let body: Uint8Array | string;
    let name: string;
    let ctype = "application/octet-stream";
    switch (kind) {
      case "simtx.db":
      case "simtx.db.tar.gz":
        body = repo.db;
        name = "simtx.db.tar.gz";
        break;
      case "simtx.db.tar.gz.sig":
      case "simtx.db.sig":
        body = repo.dbSig;
        name = "simtx.db.tar.gz.sig";
        ctype = "application/pgp-signature";
        break;
      case "simtx.files":
      case "simtx.files.tar.gz":
        body = repo.files;
        name = "simtx.files.tar.gz";
        break;
      case "simtx.files.tar.gz.sig":
      case "simtx.files.sig":
        body = repo.filesSig;
        name = "simtx.files.tar.gz.sig";
        ctype = "application/pgp-signature";
        break;
      default:
        throw new HttpError(404, "unknown repo database file");
    }
    const bytes =
      typeof body === "string" ? new TextEncoder().encode(body) : body;
    if (isHead) {
      return new Response(null, {
        headers: {
          "Content-Type": ctype,
          "Content-Length": String(bytes.length),
          ...noCache,
        },
      });
    }
    return archDb(bytes, name);
  }

  const ARCH_DB_FILES = new Set([
    "simtx.db",
    "simtx.db.tar.gz",
    "simtx.db.tar.gz.sig",
    "simtx.db.sig",
    "simtx.files",
    "simtx.files.tar.gz",
    "simtx.files.tar.gz.sig",
    "simtx.files.sig",
  ]);

  async function serveArchPool(
    filename: string,
    isHead: boolean,
  ): Promise<Response> {
    if (!/^[\w][\w.+~:-]*\.pkg\.tar\.zst(\.sig)?$/.test(filename)) {
      throw new HttpError(404, "unknown repo database file");
    }
    const wantSig = filename.endsWith(".sig");
    const pkg = await readRunFile(
      "linux",
      "latest",
      "app",
      wantSig ? "pkg.zst.sig" : "pkg.zst",
    );
    if (filename !== pkg.file) {
      throw new HttpError(404, `pool has no ${filename}`);
    }
    const headers = {
      "Content-Type": wantSig
        ? "application/pgp-signature"
        : "application/octet-stream",
      "Content-Length": String(pkg.data.length),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Release-Ref": pkg.run.head_branch,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Accept-Ranges": "bytes",
    };
    if (isHead) return new Response(null, { headers });
    return new Response(u8body(pkg.data), { headers });
  }

  // serveArch dispatches /arch/<arch>/<file>: DB/files metadata (signed,
  // 503 when unsigned) vs. package pool (always served). Checking the
  // filename first avoids triggering signKey() for package requests.
  async function serveArch(file: string, isHead: boolean): Promise<Response> {
    if (ARCH_DB_FILES.has(file)) {
      return await serveArchDb(file, isHead);
    }
    if (file.endsWith(".pkg.tar.zst") || file.endsWith(".pkg.tar.zst.sig")) {
      return await serveArchPool(file, isHead);
    }
    throw new HttpError(404, "unknown repo database file");
  }

  // -- XBPS/Void repo (/xbps/...) --------------------------------------------
  // Repodata is a gzip tar holding index.plist, index-meta.plist and an
  // empty stage.plist. Packages are <pkgver>.x86_64.xbps + raw RSA .sig2.

  interface XbpsRepo {
    repodata: Uint8Array;
    sig2: Uint8Array;
    fileName: string;
    pkgBytes: Uint8Array;
    ref: string;
    fingerprint: string;
  }
  let xbpsCache: { key: string; repo: XbpsRepo } | null = null;
  let xbpsKeyP: Promise<XbpsSigner> | null = null;

  function xbpsSignKey(): Promise<XbpsSigner> {
    const keyFile = XBPS_SIGNING_KEY;
    if (!keyFile) {
      throw new HttpError(
        503,
        "xbps repository signing is not configured (XBPS_SIGNING_KEY_FILE unset)",
      );
    }
    if (!xbpsKeyP) {
      try {
        xbpsKeyP = Promise.resolve(
          loadXbpsSigningKey(keyFile, XBPS_PASSPHRASE),
        );
      } catch (e) {
        xbpsKeyP = null;
        throw new HttpError(
          503,
          `xbps signing key invalid: ${(e as Error).message}`,
        );
      }
    }
    return xbpsKeyP;
  }

  async function xbpsRepo(): Promise<XbpsRepo> {
    // Signing first: unsigned servers answer 503 even with no builds.
    const key = await xbpsSignKey();
    const pkg = await readRunFile("linux", "latest", "app", "xbps");
    const hash = await sha256Hex(pkg.data);
    const cacheKey = `${pkg.run.head_branch}:${pkg.file}:${hash}`;
    if (xbpsCache && xbpsCache.key === cacheKey) return xbpsCache.repo;
    const parsed = await parseXbpsPackage(pkg.data);
    const files = await buildXbpsRepo(parsed, pkg.data, key, XBPS_SIGNED_BY);
    const repo: XbpsRepo = {
      repodata: files.repodata,
      sig2: files.sig2,
      fileName: files.fileName,
      pkgBytes: pkg.data,
      ref: pkg.run.head_branch,
      fingerprint: files.fingerprint,
    };
    xbpsCache = { key: cacheKey, repo };
    return repo;
  }

  async function serveXbpsPubkey(isHead: boolean): Promise<Response> {
    const key = await xbpsSignKey();
    const body = new TextEncoder().encode(key.publicKeyPem);
    const headers = {
      "Content-Type": "application/x-pem-file",
      "Content-Length": String(body.length),
      "Content-Disposition": 'attachment; filename="xbps-pubkey.pem"',
      "X-XBPS-Fingerprint": key.fingerprint,
      "X-XBPS-Key-Bits": String(key.bits),
      ...noCache,
    };
    if (isHead) return new Response(null, { headers });
    return new Response(u8body(body), { headers });
  }

  async function serveXbps(file: string, isHead: boolean): Promise<Response> {
    if (file === XBPS_REPODATA) {
      const repo = await xbpsRepo();
      const headers = {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(repo.repodata.length),
        "Content-Disposition": `attachment; filename="${XBPS_REPODATA}"`,
        ...noCache,
      };
      if (isHead) return new Response(null, { headers });
      return new Response(u8body(repo.repodata), { headers });
    }
    if (!file.endsWith(".xbps") && !file.endsWith(".xbps.sig2")) {
      throw new HttpError(404, "unknown xbps repository file");
    }
    const repo = await xbpsRepo();
    const sig2Name = `${repo.fileName}.sig2`;
    if (file !== repo.fileName && file !== sig2Name) {
      throw new HttpError(404, `xbps repo has no ${file}`);
    }
    const isSig = file === sig2Name;
    const body = isSig ? repo.sig2 : repo.pkgBytes;
    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.length),
      "Content-Disposition": `attachment; filename="${file}"`,
      "X-Release-Ref": repo.ref,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Accept-Ranges": "bytes",
    };
    if (isHead) return new Response(null, { headers });
    return new Response(u8body(body), { headers });
  }

  // -- APT (dists/stable/...) --------------------------------------------------

  interface AptRepo {
    sha256: string;
    poolName: string;
    packages: string;
    packagesGz: Uint8Array;
    release: string;
    inRelease: string;
    releaseGpg: string;
  }
  let aptCache: { key: string; expires: number; repo: AptRepo } | null = null;

  async function aptRepo(): Promise<AptRepo> {
    // Signing first: unsigned servers answer 503 even with no builds.
    const k = await signKey();
    const deb = await readRunFile("linux", "latest", "app", "deb");
    const debHash = await sha256Hex(deb.data);
    const key = `${deb.file}:${debHash}`;
    if (aptCache && aptCache.key === key && aptCache.expires > Date.now()) {
      return aptCache.repo;
    }
    const [{ stanza, fields }, h] = await Promise.all([
      debControlAsync(deb.data),
      hashFile(deb.data),
    ]);
    const poolName = debFileName(fields);
    const servedPath = `pool/${APT_COMPONENT}/${poolName}`;
    const entry = packagesEntry({
      filename: servedPath,
      size: h.size,
      md5: h.md5,
      sha1: h.sha1,
      sha256: h.sha256,
      stanza,
    });
    const packagesGz = await gzipBytes(new TextEncoder().encode(entry));
    const pkgFiles = [
      {
        path: `${APT_COMPONENT}/binary-amd64/Packages`,
        ...(await hashFile(new TextEncoder().encode(entry))),
      },
      {
        path: `${APT_COMPONENT}/binary-amd64/Packages.gz`,
        ...(await hashFile(packagesGz)),
      },
    ];
    const release = buildRelease(APT_SUITE, ["amd64"], pkgFiles, new Date());
    const releaseBytes = new TextEncoder().encode(release);
    const [inRelease, releaseGpg] = await Promise.all([
      clearSign(k, release),
      // Binary mode over exact bytes (strict verifiers reject text-mode).
      detachSign(k, releaseBytes),
    ]);
    const repo = {
      sha256: h.sha256,
      poolName,
      packages: entry,
      packagesGz,
      release,
      inRelease,
      releaseGpg,
    };
    aptCache = { key, expires: Date.now() + REPO_TTL_MS, repo };
    return repo;
  }

  const aptText = (body: string, ctype = "text/plain; charset=utf-8") =>
    new Response(body + (body.endsWith("\n") ? "" : "\n"), {
      headers: { "content-type": ctype, ...noCache },
    });

  async function serveAptRelease(name: string): Promise<Response> {
    if (name !== APT_SUITE) throw new HttpError(404, "unknown distribution");
    const repo = await aptRepo();
    return aptText(repo.release);
  }

  async function serveAptFile(
    suite: string,
    file: string,
    isHead: boolean,
  ): Promise<Response> {
    if (suite !== APT_SUITE) throw new HttpError(404, "unknown distribution");
    const repo = await aptRepo();
    let body: Uint8Array | string;
    let name: string;
    let ctype = "text/plain; charset=utf-8";
    if (file === "InRelease") {
      body = repo.inRelease;
      name = "InRelease";
    } else if (file === "Release.gpg") {
      body = repo.releaseGpg;
      name = "Release.gpg";
      ctype = "application/pgp-signature";
    } else if (file === "Packages") {
      body = repo.packages;
      name = "Packages";
    } else if (file === "Packages.gz") {
      body = repo.packagesGz;
      name = "Packages.gz";
      ctype = "application/octet-stream";
    } else {
      throw new HttpError(404, "unknown repo file");
    }
    const bytes =
      typeof body === "string" ? new TextEncoder().encode(body) : body;
    if (isHead) {
      return new Response(null, {
        headers: {
          "Content-Type": ctype,
          "Content-Length": String(bytes.length),
          ...noCache,
        },
      });
    }
    if (
      typeof body === "string" &&
      file !== "InRelease" &&
      file !== "Release.gpg"
    ) {
      return aptText(body);
    }
    return new Response(u8body(bytes), {
      headers: {
        "Content-Type": ctype,
        "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename="${name}"`,
        ...noCache,
      },
    });
  }

  // servePool serves the .deb under its conventional pool filename.
  // The versioned name is immutable, so long cache headers apply.
  async function servePool(
    comp: string,
    filename: string,
    isHead: boolean,
  ): Promise<Response> {
    if (comp !== APT_COMPONENT) throw new HttpError(404, "unknown component");
    if (!/^[\w][\w.+~:-]*\.deb$/.test(filename)) {
      throw new HttpError(404, "unknown pool file");
    }
    const deb = await readRunFile("linux", "latest", "app", "deb");
    const { fields } = await debControlAsync(deb.data);
    if (debFileName(fields) !== filename) {
      throw new HttpError(404, `pool has no ${filename}`);
    }
    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(deb.data.length),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Release-Ref": deb.run.head_branch,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Accept-Ranges": "bytes",
    };
    if (isHead) return new Response(null, { headers });
    return new Response(u8body(deb.data), { headers });
  }

  const app = new Elysia()
    .onError(({ error, code }) => {
      if (error instanceof HttpError) return text(error.message, error.status);
      if (code === "NOT_FOUND") return text("Not found", 404);
      if ((code as string) === "METHOD_NOT_FOUND") {
        return text("Method not allowed", 405);
      }
      console.error(error);
      return text("Internal server error", 500);
    })
    .get("/", () => serveIndex())
    .get("/index.html", () => serveIndex())
    .get("/install", () => serveInstall())
    .get("/api/latest", async () => json(await latestStatus()))
    .get("/api/status", async () => json(await latestStatus()))
    .get("/api/targets", () => handleTargets("latest"))
    .get("/api/targets/:ref", ({ params }) => handleTargets(params.ref))
    .get("/api/updates/latest", async () => json(await latestUpdateInfo()))
    .get("/pubkey", () => servePubkey())
    // Repo hosting: registered before the generic download routes so
    // static segments win over :ref params.
    .get("/xbps/pubkey", () => serveXbpsPubkey(false))
    .get("/xbps/:file", ({ params }) => serveXbps(params.file, false))
    .get("/arch/:arch/:file", ({ params }) => {
      if (params.arch !== "x86_64")
        throw new HttpError(422, "arch is x86_64 only");
      return serveArch(params.file, false);
    })
    .get("/dists/:suite/InRelease", ({ params }) =>
      serveAptFile(params.suite, "InRelease", false),
    )
    .get("/dists/:suite/Release", ({ params }) => serveAptRelease(params.suite))
    .get("/dists/:suite/Release.gpg", ({ params }) =>
      serveAptFile(params.suite, "Release.gpg", false),
    )
    .get("/dists/:suite/:comp/:archdir/:file", ({ params }) => {
      if (params.comp !== APT_COMPONENT)
        throw new HttpError(404, "unknown component");
      if (params.archdir !== "binary-amd64")
        throw new HttpError(404, "unknown architecture");
      return serveAptFile(params.suite, params.file, false);
    })
    .get("/pool/:comp/:filename", ({ params }) =>
      servePool(params.comp, params.filename, false),
    )
    .get("/rpmrepo/repodata/:file", ({ params }) =>
      serveRpmRepo(params.file, false),
    )
    .get("/rpmrepo/:filename", ({ params }) =>
      serveRpmPool(params.filename, false),
    )
    .get("/healthz", () => text("ok"))
    .get("/version", async () => text(await resolveVersion()))
    .get("/api/uploads/:ref", ({ request, params }) =>
      handleListUploads(request, params.ref, uploadDeps)
    )
    .put("/upload/:ref/:p1/:p2/:p3/:p4", ({ params, request }) =>
      handleUpload(
        request,
        params.ref,
        params.p1,
        params.p2,
        params.p3,
        params.p4,
        uploadDeps,
      )
    )
    .delete("/upload/:ref/:p1/:p2/:p3/:p4", ({ params, request }) =>
      handleDeleteUpload(
        request,
        params.ref,
        params.p1,
        params.p2,
        params.p3,
        params.p4,
        uploadDeps,
      )
    )
    .get("/:ref/:p1/:p2/:p3", ({ params, request }) =>
      serveDownload(
        params.ref,
        "app",
        params.p1,
        params.p2,
        params.p3,
        false,
        request.headers.get("range"),
      ),
    )
    .get("/:ref/:p1/:p2/:p3/:p4", ({ params, request }) =>
      serveDownload(
        params.ref,
        params.p1,
        params.p2,
        params.p3,
        params.p4,
        false,
        request.headers.get("range"),
      ),
    )
    .head(
      "/",
      () =>
        new Response(null, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    )
    .head(
      "/index.html",
      () =>
        new Response(null, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    )
    .head(
      "/install",
      () =>
        new Response(null, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    )
    .head("/healthz", () => new Response(null, { status: 200 }))
    .head("/pubkey", () =>
      servePubkey().then((r) => new Response(null, { headers: r.headers })),
    )
    .head("/xbps/pubkey", () => serveXbpsPubkey(true))
    .head("/xbps/:file", ({ params }) => serveXbps(params.file, true))
    .head("/arch/:arch/:file", ({ params }) => {
      if (params.arch !== "x86_64")
        throw new HttpError(422, "arch is x86_64 only");
      return serveArch(params.file, true);
    })
    .head("/dists/:suite/:comp/:archdir/:file", ({ params }) => {
      if (params.comp !== APT_COMPONENT)
        throw new HttpError(404, "unknown component");
      if (params.archdir !== "binary-amd64")
        throw new HttpError(404, "unknown architecture");
      return serveAptFile(params.suite, params.file, true);
    })
    .head("/pool/:comp/:filename", ({ params }) =>
      servePool(params.comp, params.filename, true),
    )
    .head("/rpmrepo/repodata/:file", ({ params }) =>
      serveRpmRepo(params.file, true),
    )
    .head("/rpmrepo/:filename", ({ params }) =>
      serveRpmPool(params.filename, true),
    )
    .head("/:ref/:p1/:p2/:p3", ({ params }) =>
      serveDownload(params.ref, "app", params.p1, params.p2, params.p3, true),
    )
    .head("/:ref/:p1/:p2/:p3/:p4", ({ params }) =>
      serveDownload(
        params.ref,
        params.p1,
        params.p2,
        params.p3,
        params.p4,
        true,
      ),
    );

  return {
    app,
    latestStatus,
    getTargets,
    resolveRun,
    resolveVersion,
    latestTagVersion,
    serveDownload,
    downloadArtifact,
    ensureExtracted,
    pruneCache,
    prefetchLatest,
    setFetchImpl(fn: typeof fetch) {
      fetchFn = fn;
    },
    clearCaches() {
      runCache.clear();
      targetsCache.clear();
      inflight.clear();
      cachedIndex = null;
      cachedVersion = null;
      rpmCache = null;
      archCache = null;
      aptCache = null;
      xbpsCache = null;
    },
  };
}

export type SimtxApp = ReturnType<typeof createApp>;
