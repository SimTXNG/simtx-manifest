// simtx-releases.ts
//
// Serves the build artifacts of simtxng/transmitter-go (GitHub Actions) as plain downloads:
//
//   /                              landing page (index.html)
//   /api/latest                    JSON status for the landing page
//   /latest/linux/amd64/deb        /<tag>/linux/amd64/deb
//   /latest/linux/amd64/appimage   /<tag>/linux/amd64/appimage
//   /latest/windows/amd64/exe      /<tag>/windows/amd64/exe
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
//   PORT               default 8000
//   HOST               default 0.0.0.0
//   CACHE_DIR          default ./cache   (extracted files, keyed by workflow run id)
//   LATEST_TTL         default 60        (seconds to cache the "latest" -> run lookup)
//   TAG_TTL            default 300       (seconds to cache a tag -> run lookup)
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
const LATEST_REF = env("LATEST_REF");
const VERSION_RETURN = env("VERSION_RETURN")?.trim();

// os -> workflow file + (url kind -> file extension inside the artifact)
const TARGETS: Record<
  string,
  { workflow: string; kinds: Record<string, string> }
> = {
  linux: {
    workflow: env("LINUX_WORKFLOW", "build-linux.yml")!,
    kinds: { deb: ".deb", appimage: ".appimage" },
  },
  windows: {
    workflow: env("WINDOWS_WORKFLOW", "build-windows.yml")!,
    kinds: { exe: ".exe" },
  },
};

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const WANTED_EXTS = [".deb", ".appimage", ".exe"];

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
  const [linuxRun, windowsRun] = await Promise.all([
    resolveRun(TARGETS.linux.workflow, "latest"),
    resolveRun(TARGETS.windows.workflow, "latest"),
  ]);
  const linux = runInfo(linuxRun);
  const windows = runInfo(windowsRun);
  // newest build time across both platforms
  const times = [linux?.built_at, windows?.built_at].filter(Boolean) as string[];
  const newest = times.sort().at(-1) ?? null;
  return {
    version: VERSION_RETURN ?? null,
    repo: REPO,
    newest_built_at: newest,
    linux,
    windows,
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

// Pulls .deb/.AppImage/.exe out of a zip. If the artifact turns out to be
// double-zipped (a .zip inside GitHub's own zip), it recurses into the inner one.
function collect(
  zip: Uint8Array,
  out: Record<string, Uint8Array> = {},
  depth = 0,
) {
  const entries = unzipSync(zip, {
    filter: (f) => {
      const n = f.name.toLowerCase();
      return n.endsWith(".zip") || WANTED_EXTS.some((e) => n.endsWith(e));
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
    throw new HttpError(502, "Artifact contained no .deb/.AppImage/.exe files");
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

  // /version -> the hardcoded release version from the VERSION_RETURN env var
  if (parts.length === 1 && parts[0].toLowerCase() === "version") {
    if (!VERSION_RETURN)
      throw new HttpError(503, "VERSION_RETURN is not configured");
    return text(VERSION_RETURN);
  }

  if (parts.length !== 4) throw new HttpError(404, "Not found");

  const [ref, osRaw, arch, kindRaw] = parts;
  const os = osRaw.toLowerCase();
  const kind = kindRaw.toLowerCase();

  if (!VERSION_RE.test(ref)) throw new HttpError(400, "Invalid version");
  if (arch !== "amd64" && arch !== "x86_64")
    throw new HttpError(404, "Only amd64 is available");
  const target = TARGETS[os];
  const ext = target?.kinds[kind];
  if (!target || !ext) throw new HttpError(404, "Not found");

  const run = await resolveRun(target.workflow, ref);
  if (!run)
    throw new HttpError(404, `No successful ${os} build found for "${ref}"`);

  const dir = await ensureExtracted(run.id);
  let file: string | undefined;
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.toLowerCase().endsWith(ext))
      file = entry.name;
  }
  if (!file)
    throw new HttpError(404, `No ${kind} in the ${ref} ${os} artifact`);

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
