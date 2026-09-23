// simtx-releases.ts
//
// Serves the build artifacts of simtxng/transmitter-go (GitHub Actions) as plain downloads:
//
//   /                              landing page (index.html)
//   /api/latest                    JSON status for the landing page
//   /api/targets[/<ref>]           JSON availability map: which product/os/arch/kind
//                                  downloads actually exist (default ref "latest")
//
//   Canonical (5 segments):
//   /<ref>/<app|cli>/<linux|windows|macos>/<amd64|arm64>/<kind>
//     app/linux:   deb | appimage | rpm | pkg.zst (aliases: pkg.tar.zst, arch)
//     app/windows: exe
//     app/macos:   dmg                             (arm64 only, styled DMG)
//     cli/linux:   binary          (standalone simtx-cli, extensionless)
//     cli/windows: binary | exe    (standalone simtx-cli.exe)
//     cli/macos:   binary          (standalone simtx-cli, arm64)
//     (linux/windows are amd64-only; macos is arm64-only)
//
//   Legacy (4 segments, still served):
//   /<ref>/linux/amd64/deb | appimage
//   /<ref>/windows/amd64/exe
//
//   /version                       returns the VERSION_RETURN env var as plain text
//
// /latest/ = newest successful run of the workflow on ANY branch or tag.
//
// Run:
//   GITHUB_TOKEN=... deno run --allow-net --allow-env --allow-read --allow-write simtx-releases.ts
//
// Config (environment variables):
//   GITHUB_TOKEN       required. Needs "Actions: read" (artifact downloads need auth even on public repos)
//   GITHUB_REPO        default simtxng/transmitter-go
//   LINUX_WORKFLOW     default build-linux.yml
//   WINDOWS_WORKFLOW   default build-windows.yml
//   MACOS_WORKFLOW     default build-macos.yml
//   PORT               default 8000
//   HOST               default 0.0.0.0
//   CACHE_DIR          default ./cache   (extracted files, keyed by workflow run id)
//   LATEST_TTL         default 60        (seconds to cache the "latest" -> run lookup)
//   TAG_TTL            default 300       (seconds to cache a tag -> run lookup)
//   TARGETS_TTL        default 300       (seconds to cache the /api/targets availability map)
//   PREFETCH           default 1         (download+extract latest artifacts on startup; 0 to disable)
//   REFRESH_INTERVAL   default 300       (seconds between background refreshes; 0 to disable)
//   CACHE_MAX_RUNS     default 10        (max cached run dirs on disk; 0 = unbounded)
//   LATEST_REF         optional. Pin "latest" to one branch/tag (e.g. main) instead of any ref
//   VERSION_RETURN     the version string /version returns, e.g. v0.0.1 (503 if unset)
import { load } from "jsr:@std/dotenv";
import { unzipSync } from "npm:fflate@0.8.2";

await load({
  // optional: choose a specific path (defaults to ".env")
  envPath: ".env",
  export: true,
});
const env = (key: string, fallback?: string) => process.env[key] ?? fallback;

const TOKEN = env("GITHUB_TOKEN");
if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  Deno.exit(1);
}
const REPO = env("GITHUB_REPO", "simtxng/transmitter-go")!;
const HOST = env("HOST", "0.0.0.0")!;
const PORT = Number(env("PORT", "8000"));
const CACHE_DIR = env("CACHE_DIR", "./cache")!;
const LATEST_TTL = Number(env("LATEST_TTL", "60")) * 1000;
const TAG_TTL = Number(env("TAG_TTL", "300")) * 1000;
const TARGETS_TTL = Number(env("TARGETS_TTL", "300")) * 1000;
const PREFETCH = env("PREFETCH", "1") !== "0";
const REFRESH_INTERVAL = Number(env("REFRESH_INTERVAL", "300")) * 1000;
const CACHE_MAX_RUNS = Number(env("CACHE_MAX_RUNS", "10"));
const LATEST_REF = env("LATEST_REF");
const VERSION_RETURN = env("VERSION_RETURN")?.trim();

// os -> workflow file. Product/kind -> file matcher inside the artifact.
const WORKFLOWS: Record<string, string> = {
  linux: env("LINUX_WORKFLOW", "build-linux.yml")!,
  windows: env("WINDOWS_WORKFLOW", "build-windows.yml")!,
  macos: env("MACOS_WORKFLOW", "build-macos.yml")!,
};

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
// Extensions collected out of artifact zips (lowercased match).
const WANTED_EXTS = [".deb", ".appimage", ".exe", ".rpm", ".pkg.tar.zst", ".dmg"];
// Extensionless Unix CLI binary (linux + macos) — matched by exact name, not ext.
const CLI_UNIX_NAMES = ["simtx-cli"];
const CLI_WINDOWS_NAMES = ["simtx-cli.exe"];

const isCliUnix = (n: string) => CLI_UNIX_NAMES.includes(n.toLowerCase());
const isCliWindows = (n: string) => CLI_WINDOWS_NAMES.includes(n.toLowerCase());

// Returns true if `name` (original case) is the file wanted for product/os/kind.
function matchesTarget(
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
  // product === "app"
  if (os === "linux") {
    if (kind === "deb") return n.endsWith(".deb");
    if (kind === "appimage") return n.endsWith(".appimage");
    if (kind === "rpm") return n.endsWith(".rpm");
    if (kind === "pkg.zst" || kind === "pkg.tar.zst" || kind === "arch") {
      return n.endsWith(".pkg.tar.zst");
    }
    return false;
  }
  if (os === "windows") {
    // GUI installer only — never the standalone CLI.
    return n.endsWith(".exe") && !isCliWindows(n);
  }
  if (os === "macos") {
    // Styled DMG holding the .app bundle (GUI + bundled CLI inside).
    return n.endsWith(".dmg");
  }
  return false;
}

// Normalize kind aliases from the URL to canonical kinds.
function normalizeKind(product: string, os: string, kind: string): string | null {
  if (product === "app" && os === "linux") {
    if (kind === "deb" || kind === "appimage" || kind === "rpm") return kind;
    if (kind === "pkg.zst" || kind === "pkg.tar.zst" || kind === "arch") {
      return "pkg.zst";
    }
    return null;
  }
  if (product === "app" && os === "windows") {
    return kind === "exe" ? "exe" : null;
  }
  if (product === "app" && os === "macos") {
    return kind === "dmg" ? "dmg" : null;
  }
  if (product === "cli" && (os === "linux" || os === "macos")) {
    return kind === "binary" ? "binary" : null;
  }
  if (product === "cli" && os === "windows") {
    if (kind === "binary") return "binary";
    if (kind === "exe") return "binary";
    return null;
  }
  return null;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const text = (body: string, status = 200) =>
  new Response(body + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

// ---------- GitHub API ----------

const gh = (path: string, init: RequestInit = {}) =>
  fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "simtx-releases",
      ...init.headers,
    },
  });

async function ghJson<T>(path: string): Promise<T> {
  const res = await gh(path);
  if (!res.ok) {
    await res.body?.cancel();
    throw new HttpError(502, `GitHub API returned ${res.status} for ${path}`);
  }
  return (await res.json()) as T;
}

type Run = {
  id: number;
  head_branch: string;
  head_sha: string;
  run_number: number;
  display_title: string;
  name: string;
  html_url: string;
  created_at: string;
  updated_at: string;
};
type RunList = { workflow_runs: Run[] };

function runInfo(run: Run | null) {
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

async function latestStatus() {
  const [linuxRun, windowsRun, macosRun] = await Promise.all([
    resolveRun(WORKFLOWS.linux, "latest"),
    resolveRun(WORKFLOWS.windows, "latest"),
    resolveRun(WORKFLOWS.macos, "latest"),
  ]);
  const linux = runInfo(linuxRun);
  const windows = runInfo(windowsRun);
  const macos = runInfo(macosRun);
  // newest build time across all platforms
  const times = [linux?.built_at, windows?.built_at, macos?.built_at].filter(
    Boolean,
  ) as string[];
  const newest = times.sort().at(-1) ?? null;
  return {
    version: VERSION_RETURN ?? null,
    repo: REPO,
    newest_built_at: newest,
    linux,
    windows,
    macos,
  };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });

// ---------- availability (/api/targets) ----------

type TargetDef = {
  product: string;
  os: string;
  arch: string;
  kind: string;
};

// Every downloadable target. URL kind == canonical kind here.
const TARGET_DEFS: TargetDef[] = [
  { product: "app", os: "linux", arch: "amd64", kind: "deb" },
  { product: "app", os: "linux", arch: "amd64", kind: "rpm" },
  { product: "app", os: "linux", arch: "amd64", kind: "pkg.zst" },
  { product: "app", os: "linux", arch: "amd64", kind: "appimage" },
  { product: "app", os: "windows", arch: "amd64", kind: "exe" },
  { product: "app", os: "macos", arch: "arm64", kind: "dmg" },
  { product: "cli", os: "linux", arch: "amd64", kind: "binary" },
  { product: "cli", os: "windows", arch: "amd64", kind: "binary" },
  { product: "cli", os: "macos", arch: "arm64", kind: "binary" },
];

const targetsCache = new Map<string, { data: unknown; expires: number }>();

async function buildTargets(ref: string) {
  const oss = Object.keys(WORKFLOWS);
  const runs = await Promise.all(
    oss.map(async (os) => ({ os, run: await resolveRun(WORKFLOWS[os], ref) })),
  );
  const targets = await Promise.all(
    TARGET_DEFS.map(async (t) => {
      const base = {
        ...t,
        url: `/${ref}/${t.product}/${t.os}/${t.arch}/${t.kind}`,
      };
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
      let names: string[] = [];
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
    version: VERSION_RETURN ?? null,
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
    // Serve last-known-good rather than failing the page.
    if (hit) return { ...(hit.data as Record<string, unknown>), stale: true };
    throw e;
  }
}

let cachedIndex: Uint8Array | null = null;
async function serveIndex(): Promise<Response> {
  try {
    // re-read in dev so edits show without restart; cheap for a small file
    cachedIndex = await Deno.readFile(
      new URL("./index.html", import.meta.url),
    );
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

async function findRun(workflow: string, ref: string): Promise<Run | null> {
  const wf = encodeURIComponent(workflow);
  const branch = ref === "latest" ? LATEST_REF : ref;

  // For tag pushes GitHub sets head_branch to the tag name.
  // "latest" with no LATEST_REF = newest successful run on any branch or tag.
  const filter = branch ? `&branch=${encodeURIComponent(branch)}` : "";
  const { workflow_runs } = await ghJson<RunList>(
    `/actions/workflows/${wf}/runs?status=success&per_page=1${filter}`,
  );
  return workflow_runs[0] ?? null;
}

const runCache = new Map<string, { run: Run | null; expires: number }>();

async function resolveRun(workflow: string, ref: string): Promise<Run | null> {
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

// ---------- artifact download + extraction ----------

async function downloadArtifact(id: number): Promise<Uint8Array> {
  // GitHub answers with a 302 to a pre-signed URL; don't forward our token there.
  let res = await gh(`/actions/artifacts/${id}/zip`, { redirect: "manual" });
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) {
    await res.body?.cancel();
    res = await fetch(location);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new HttpError(502, `Artifact download failed (${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// Pulls .deb/.rpm/.pkg.tar.zst/.AppImage/.exe + the extensionless
// simtx-cli out of a zip. If the artifact turns out to be
// double-zipped (a .zip inside GitHub's own zip), it recurses into the inner one.
function collect(
  zip: Uint8Array,
  out: Record<string, Uint8Array> = {},
  depth = 0,
) {
  const entries = unzipSync(zip, {
    filter: (f) => {
      const n = f.name.toLowerCase();
      return n.endsWith(".zip") ||
        WANTED_EXTS.some((e) => n.endsWith(e)) ||
        isCliUnix(n.split("/").pop() ?? "");
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

const inflight = new Map<number, Promise<string>>();

// Returns the cache dir for a run, downloading + extracting it first if needed.
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
  try {
    await Deno.stat(dir);
    return dir;
  } catch {
    /* not cached yet */
  }

  const { artifacts } = await ghJson<{
    artifacts: { id: number; expired: boolean }[];
  }>(`/actions/runs/${runId}/artifacts`);
  const artifact = artifacts.find((a) => !a.expired);
  if (!artifact)
    throw new HttpError(410, "Artifact expired or missing for this build");

  const files = collect(await downloadArtifact(artifact.id));
  if (Object.keys(files).length === 0) {
    throw new HttpError(
      502,
      "Artifact contained no .deb/.rpm/.pkg.tar.zst/.AppImage/.exe/simtx-cli files",
    );
  }

  // write to a temp dir, then rename so a half-written cache is never served
  const partial = `${dir}.partial`;
  await Deno.remove(partial, { recursive: true }).catch(() => {});
  await Deno.mkdir(partial, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    await Deno.writeFile(`${partial}/${name}`, data);
  }
  await Deno.rename(partial, dir);
  return dir;
}

// ---------- prefetch (warm cache so first visitors get local files) ----------

// Downloads + extracts the latest artifacts for every workflow in the
// background. Failures are logged, never thrown — serving stays up.
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
      console.error(`[prefetch:${reason}] ${os} failed:`, (e as Error).message);
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

// Keeps only the newest CACHE_MAX_RUNS cached run dirs on disk.
async function pruneCache(): Promise<void> {
  const entries: { name: string; mtime: number }[] = [];
  for await (const entry of Deno.readDir(CACHE_DIR)) {
    if (!entry.isDirectory || entry.name.endsWith(".partial")) continue;
    if (!/^\d+$/.test(entry.name)) continue;
    const mtime = (await Deno.stat(`${CACHE_DIR}/${entry.name}`)).mtime
      ?.getTime() ?? 0;
    entries.push({ name: entry.name, mtime });
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  for (const stale of entries.slice(CACHE_MAX_RUNS)) {
    await Deno.remove(`${CACHE_DIR}/${stale.name}`, { recursive: true });
    console.log(`[prune] removed cached run ${stale.name}`);
  }
}

// ---------- HTTP ----------

async function handle(req: Request): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    throw new HttpError(405, "Method not allowed");
  }

  let parts: string[];
  try {
    parts = new URL(req.url).pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
  } catch {
    throw new HttpError(400, "Bad path");
  }

  // / -> beautiful landing page
  if (
    parts.length === 0 ||
    (parts.length === 1 && parts[0].toLowerCase() === "index.html")
  ) {
    if (req.method === "HEAD") {
      return new Response(null, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return await serveIndex();
  }

  // /api/latest -> JSON used by the landing page
  if (
    parts.length === 2 && parts[0].toLowerCase() === "api" &&
    (parts[1].toLowerCase() === "latest" || parts[1].toLowerCase() === "status")
  ) {
    return json(await latestStatus());
  }

  // /api/targets[/<ref>] -> which downloads actually exist (used to hide missing ones)
  if (
    parts.length >= 2 && parts.length <= 3 &&
    parts[0].toLowerCase() === "api" && parts[1].toLowerCase() === "targets"
  ) {
    const ref = parts.length === 3 ? parts[2] : "latest";
    if (!VERSION_RE.test(ref)) throw new HttpError(400, "Invalid version");
    return json(await getTargets(ref));
  }

  // /healthz -> liveness probe, no GitHub calls
  if (parts.length === 1 && parts[0].toLowerCase() === "healthz") {
    if (req.method === "HEAD") return new Response(null, { status: 200 });
    return text("ok");
  }

  // /version -> the hardcoded release version from the VERSION_RETURN env var
  if (parts.length === 1 && parts[0].toLowerCase() === "version") {
    if (!VERSION_RETURN)
      throw new HttpError(503, "VERSION_RETURN is not configured");
    return text(VERSION_RETURN);
  }

  if (parts.length !== 4 && parts.length !== 5) {
    throw new HttpError(404, "Not found");
  }

  let ref: string;
  let product: string;
  let os: string;
  let arch: string;
  let kind: string;

  if (parts.length === 4) {
    // Legacy: /<ref>/<os>/<arch>/<kind> (app only)
    const [refRaw, osRaw, archRaw, kindRaw] = parts;
    ref = refRaw;
    product = "app";
    os = osRaw.toLowerCase();
    arch = archRaw.toLowerCase();
    kind = kindRaw.toLowerCase();
  } else {
    // Canonical: /<ref>/<app|cli>/<os>/<arch>/<kind>
    const [refRaw, productRaw, osRaw, archRaw, kindRaw] = parts;
    ref = refRaw;
    product = productRaw.toLowerCase();
    os = osRaw.toLowerCase();
    arch = archRaw.toLowerCase();
    kind = kindRaw.toLowerCase();
    if (product !== "app" && product !== "cli") {
      throw new HttpError(404, "Not found");
    }
  }

  if (!VERSION_RE.test(ref)) throw new HttpError(400, "Invalid version");
  if (os !== "linux" && os !== "windows" && os !== "macos") {
    throw new HttpError(404, "Not found");
  }
  // Platform/arch matrix: linux+windows ship amd64, macos ships arm64 (Apple Silicon).
  const archNorm = arch === "x86_64"
    ? "amd64"
    : arch === "aarch64"
    ? "arm64"
    : arch;
  if (os === "macos") {
    if (archNorm !== "arm64") {
      throw new HttpError(404, "macOS is arm64 (Apple Silicon) only");
    }
  } else if (archNorm !== "amd64") {
    if (archNorm === "arm64") {
      throw new HttpError(404, `${os} arm64 is not available yet`);
    }
    throw new HttpError(404, "Only amd64 is available");
  }
  const workflow = WORKFLOWS[os];
  if (!workflow) throw new HttpError(404, "Not found");
  const canonicalKind = normalizeKind(product, os, kind);
  if (!canonicalKind) throw new HttpError(404, "Not found");

  const run = await resolveRun(workflow, ref);
  if (!run) {
    throw new HttpError(
      404,
      `No successful ${os} build found for "${ref}"`,
    );
  }

  const dir = await ensureExtracted(run.id);
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile) names.push(entry.name);
  }
  names.sort((a, b) => a.localeCompare(b));
  const file = names.find((n) =>
    matchesTarget(product, os, canonicalKind, n)
  );
  if (!file) {
    throw new HttpError(
      404,
      `No ${kind} (${product}/${os}) in the ${ref} artifact`,
    );
  }

  const path = `${dir}/${file}`;
  const { size } = await Deno.stat(path);
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": String(size),
    "Content-Disposition": `attachment; filename="${file}"`,
    "X-Release-Ref": run.head_branch,
    "Cache-Control":
      ref === "latest" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  if (req.method === "HEAD") return new Response(null, { headers });
  return new Response((await Deno.open(path)).readable, { headers });
}

await Deno.mkdir(CACHE_DIR, { recursive: true });

// Warm the cache in the background so the first visitor downloads from disk,
// then keep it fresh on an interval. Never blocks serving.
if (PREFETCH) {
  prefetchLatest("startup");
  if (REFRESH_INTERVAL > 0) {
    setInterval(() => prefetchLatest("refresh"), REFRESH_INTERVAL);
  }
}

Deno.serve(
  {
    hostname: HOST,
    port: PORT,
    onListen: ({ hostname, port }) =>
      console.log(
        `simtx-releases serving ${REPO} on http://${hostname}:${port}`,
      ),
  },
  async (req) => {
    try {
      return await handle(req);
    } catch (e) {
      if (e instanceof HttpError) return text(e.message, e.status);
      console.error(e);
      return text("Internal server error", 500);
    }
  },
);
