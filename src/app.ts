import { Elysia } from "elysia";
import type { z } from "zod";
import { unzipSync } from "fflate";
import {
  AppOptionsSchema,
  ArtifactsSchema,
  DownloadParamsSchema,
  HttpError,
  parseOr422,
  RefSchema,
  RunListSchema,
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
  ".exe",
  ".rpm",
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
    if (kind === "appimage") return n.endsWith(".appimage");
    if (kind === "rpm") return n.endsWith(".rpm");
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
  { product: "app", os: "linux", arch: "amd64", kind: "pkg.zst" },
  { product: "app", os: "linux", arch: "amd64", kind: "appimage" },
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

export type AppOptions = ValidatedOptions & {
  indexFileUrl?: URL | string;
  fetchImpl?: typeof fetch;
};

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
  const INDEX_URL = opts.indexFileUrl ??
    new URL("./static/index.html", import.meta.url);

  let fetchFn: typeof fetch = opts.fetchImpl ?? fetch;
  const runCache = new Map<string, { run: Run | null; expires: number }>();
  const targetsCache = new Map<string, { data: unknown; expires: number }>();
  const inflight = new Map<number, Promise<string>>();
  let cachedIndex: Uint8Array | null = null;

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
      throw new HttpError(
        502,
        `GitHub API returned ${res.status} for ${path}`,
      );
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

  async function latestStatus() {
    const [linuxRun, windowsRun, macosRun] = await Promise.all([
      resolveRun(WORKFLOWS.linux, "latest"),
      resolveRun(WORKFLOWS.windows, "latest"),
      resolveRun(WORKFLOWS.macos, "latest"),
    ]);
    const linux = runInfo(linuxRun);
    const windows = runInfo(windowsRun);
    const macos = runInfo(macosRun);
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

  async function buildTargets(ref: string) {
    const oss = Object.keys(WORKFLOWS) as Os[];
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
      if (hit) return { ...(hit.data as Record<string, unknown>), stale: true };
      throw e;
    }
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
    const cached = await Deno.stat(dir).then(() => true).catch(() => false);
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
        "Artifact contained no .deb/.rpm/.pkg.tar.zst/.AppImage/.exe/simtx-cli files",
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
    if (CACHE_MAX_RUNS <= 0) return;    const entries: { name: string; mtime: number }[] = [];
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

  async function serveDownload(
    refRaw: string,
    productRaw: string,
    osRaw: string,
    archRaw: string,
    kindRaw: string,
    isHead: boolean,
  ): Promise<Response> {
    const { ref, product, os, kind } = parseOr422(
      DownloadParamsSchema,
      {
        ref: refRaw,
        product: productRaw,
        os: osRaw,
        arch: archRaw,
        kind: kindRaw,
      },
    );
    const workflow = WORKFLOWS[os];

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
      matchesTarget(product, os, kind, n)
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
    if (isHead) return new Response(null, { headers });
    return new Response((await Deno.open(path)).readable, { headers });
  }

  async function handleTargets(refRaw: string): Promise<Response> {
    const ref = parseOr422(RefSchema, refRaw);
    return json(await getTargets(ref));
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
    .get("/api/latest", async () => json(await latestStatus()))
    .get("/api/status", async () => json(await latestStatus()))
    .get("/api/targets", () => handleTargets("latest"))
    .get("/api/targets/:ref", ({ params }) => handleTargets(params.ref))
    .get("/healthz", () => text("ok"))
    .get("/version", () => {
      if (!VERSION_RETURN) {
        throw new HttpError(503, "VERSION_RETURN is not configured");
      }
      return text(VERSION_RETURN);
    })
    .get("/:ref/:p1/:p2/:p3", ({ params }) =>
      serveDownload(
        params.ref,
        "app",
        params.p1,
        params.p2,
        params.p3,
        false,
      ))
    .get("/:ref/:p1/:p2/:p3/:p4", ({ params }) =>
      serveDownload(
        params.ref,
        params.p1,
        params.p2,
        params.p3,
        params.p4,
        false,
      ))
    .head("/", () =>
      new Response(null, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }))
    .head("/index.html", () =>
      new Response(null, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }))
    .head("/healthz", () => new Response(null, { status: 200 }))
    .head("/:ref/:p1/:p2/:p3", ({ params }) =>
      serveDownload(params.ref, "app", params.p1, params.p2, params.p3, true))
    .head("/:ref/:p1/:p2/:p3/:p4", ({ params }) =>
      serveDownload(
        params.ref,
        params.p1,
        params.p2,
        params.p3,
        params.p4,
        true,
      ));

  return {
    app,
    latestStatus,
    getTargets,
    resolveRun,
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
    },
  };
}

export type SimtxApp = ReturnType<typeof createApp>;
