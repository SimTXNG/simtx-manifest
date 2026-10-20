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
  HOST: env("HOST"),
  PORT: env("PORT"),
  CACHE_DIR: env("CACHE_DIR"),
  TAG_TTL: env("TAG_TTL"),
  TARGETS_TTL: env("TARGETS_TTL"),
  VERSION_RETURN: env("VERSION_RETURN"),
  SIGNING_KEY_FILE: env("SIGNING_KEY_FILE"),
  XBPS_SIGNING_KEY_FILE: env("XBPS_SIGNING_KEY_FILE"),
  XBPS_SIGNED_BY: env("XBPS_SIGNED_BY"),
  XBPS_PASSPHRASE: env("XBPS_PASSPHRASE"),
  UPLOAD_TOKEN: env("UPLOAD_TOKEN"),
  UPLOAD_MAX_MB: env("UPLOAD_MAX_MB"),
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

// XBPS uses a separate RSA key from the Ed25519 package-signing key.
// Absent → /xbps repo routes answer 503; direct .xbps downloads still serve.
let xbpsSigningKey: string | undefined;
if (cfg.XBPS_SIGNING_KEY_FILE) {
  try {
    xbpsSigningKey =
      (await Deno.readTextFile(cfg.XBPS_SIGNING_KEY_FILE)).trim() || undefined;
  } catch (e) {
    console.error(`Cannot read XBPS_SIGNING_KEY_FILE: ${(e as Error).message}`);
    Deno.exit(1);
  }
  const { loadXbpsSigningKey } = await import("./repo-xbps.ts");
  try {
    const key = loadXbpsSigningKey(
      xbpsSigningKey!,
      cfg.XBPS_PASSPHRASE,
    );
    console.log(
      `xbps signing key OK (${key.bits} bit, ${key.fingerprint})`,
    );
  } catch (e) {
    console.error(`Invalid XBPS signing key: ${(e as Error).message}`);
    Deno.exit(1);
  }
}

const HOST = cfg.HOST;
const PORT = cfg.PORT;
const CACHE_DIR = cfg.CACHE_DIR;

const ctx = createApp({
  cacheDir: CACHE_DIR,
  tagTtlMs: cfg.TAG_TTL * 1000,
  targetsTtlMs: cfg.TARGETS_TTL * 1000,
  versionReturn: cfg.VERSION_RETURN?.trim() || undefined,
  signingKey,
  xbpsSigningKey,
  xbpsSignedBy: cfg.XBPS_SIGNED_BY?.trim() || undefined,
  xbpsPassphrase: cfg.XBPS_PASSPHRASE,
  uploadToken: cfg.UPLOAD_TOKEN?.trim() || undefined,
  uploadMaxBytes: cfg.UPLOAD_MAX_MB * 1024 * 1024,
});

await Deno.mkdir(CACHE_DIR, { recursive: true });

Deno.serve(
  {
    hostname: HOST,
    port: PORT,
    onListen: ({ hostname, port }) =>
      console.log(
        `simtx-manifest serving uploads from ${CACHE_DIR} on http://${hostname}:${port}`,
      ),
  },
  ctx.app.fetch,
);
