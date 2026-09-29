import { load } from "@std/dotenv";
import { z } from "zod";
import { createApp } from "./app.ts";
import { EnvSchema } from "./validation.ts";

await load({
  envPath: ".env",
  export: true,
});
const env = (key: string, fallback?: string) => process.env[key] ?? fallback;

const parsed = EnvSchema.safeParse({
  GITHUB_TOKEN: env("GITHUB_TOKEN"),
  GITHUB_REPO: env("GITHUB_REPO"),
  HOST: env("HOST"),
  PORT: env("PORT"),
  CACHE_DIR: env("CACHE_DIR"),
  LATEST_TTL: env("LATEST_TTL"),
  TAG_TTL: env("TAG_TTL"),
  TARGETS_TTL: env("TARGETS_TTL"),
  PREFETCH: env("PREFETCH"),
  REFRESH_INTERVAL: env("REFRESH_INTERVAL"),
  CACHE_MAX_RUNS: env("CACHE_MAX_RUNS"),
  LINUX_WORKFLOW: env("LINUX_WORKFLOW"),
  WINDOWS_WORKFLOW: env("WINDOWS_WORKFLOW"),
  MACOS_WORKFLOW: env("MACOS_WORKFLOW"),
  LATEST_REF: env("LATEST_REF"),
  VERSION_RETURN: env("VERSION_RETURN"),
  SIGNING_KEY_FILE: env("SIGNING_KEY_FILE"),
});
if (!parsed.success) {
  console.error("Invalid configuration:\n" + z.prettifyError(parsed.error));
  Deno.exit(1);
}
const cfg = parsed.data;

// Repo metadata signing: SIGNING_KEY_FILE points at a file holding the
// armored private key (chmod 600, never committed). Absent → repo
// metadata routes answer 503; packages still serve.
let signingKey: string | undefined;
if (cfg.SIGNING_KEY_FILE) {
  try {
    signingKey = (await Deno.readTextFile(cfg.SIGNING_KEY_FILE)).trim() || undefined;
  } catch (e) {
    console.error(`Cannot read SIGNING_KEY_FILE: ${(e as Error).message}`);
    Deno.exit(1);
  }
  const { loadSigningKey } = await import("./repo-sign.ts");
  try {
    await loadSigningKey(signingKey!);
    console.log("repo signing key OK");
  } catch (e) {
    console.error(`Invalid signing key: ${(e as Error).message}`);
    Deno.exit(1);
  }
}

const REPO = cfg.GITHUB_REPO;
const HOST = cfg.HOST;
const PORT = cfg.PORT;
const CACHE_DIR = cfg.CACHE_DIR;
const PREFETCH = cfg.PREFETCH;
const REFRESH_INTERVAL = cfg.REFRESH_INTERVAL * 1000;

const ctx = createApp({
  repo: REPO,
  token: cfg.GITHUB_TOKEN,
  workflows: {
    linux: cfg.LINUX_WORKFLOW,
    windows: cfg.WINDOWS_WORKFLOW,
    macos: cfg.MACOS_WORKFLOW,
  },
  cacheDir: CACHE_DIR,
  latestTtlMs: cfg.LATEST_TTL * 1000,
  tagTtlMs: cfg.TAG_TTL * 1000,
  targetsTtlMs: cfg.TARGETS_TTL * 1000,
  cacheMaxRuns: cfg.CACHE_MAX_RUNS,
  latestRef: cfg.LATEST_REF,
  versionReturn: cfg.VERSION_RETURN?.trim() || undefined,
  signingKey,
});

await Deno.mkdir(CACHE_DIR, { recursive: true });

if (PREFETCH) {
  ctx.prefetchLatest("startup");
  if (REFRESH_INTERVAL > 0) {
    setInterval(() => ctx.prefetchLatest("refresh"), REFRESH_INTERVAL);
  }
}

Deno.serve(
  {
    hostname: HOST,
    port: PORT,
    onListen: ({ hostname, port }) =>
      console.log(
        `simtx-manifest serving ${REPO} on http://${hostname}:${port}`,
      ),
  },
  ctx.app.fetch,
);
