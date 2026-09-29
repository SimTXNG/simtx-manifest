import { z } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseOr422<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new HttpError(422, z.prettifyError(result.error));
  return result.data;
}

export const RefSchema = z.string().toLowerCase().regex(
  /^[a-z0-9][a-z0-9._+-]{0,127}$/,
);

export const ProductSchema = z.string().toLowerCase().pipe(
  z.enum(["app", "cli"]),
);
export type Product = z.infer<typeof ProductSchema>;

export const OsSchema = z.string().toLowerCase().pipe(
  z.enum(["linux", "windows", "macos"]),
);
export type Os = z.infer<typeof OsSchema>;

const ArchInputSchema = z.string().toLowerCase().pipe(
  z.enum(["amd64", "arm64", "x86_64", "aarch64"]),
);
const KindInputSchema = z.string().toLowerCase();

const ARCH_CANONICAL: Record<string, "amd64" | "arm64"> = {
  x86_64: "amd64",
  aarch64: "arm64",
};

const KIND_ALIASES: Record<string, string> = {
  "pkg.tar.zst": "pkg.zst",
  arch: "pkg.zst",
};

export function aliasKind(kind: string): string {
  return KIND_ALIASES[kind] ?? kind;
}

export function canonicalKind(
  product: Product,
  os: Os,
  kind: string,
): string | null {
  const k = aliasKind(kind);
  if (product === "app" && os === "linux") {
    return ["deb", "appimage", "appimage-zsync", "appimage-sha256", "rpm", "pkg.zst", "pkg.zst.sig"].includes(k) ? k : null;
  }
  if (product === "app" && os === "windows") {
    return k === "exe" ? k : null;
  }
  if (product === "app" && os === "macos") {
    return k === "dmg" ? k : null;
  }
  if (product === "cli" && (os === "linux" || os === "macos")) {
    return k === "binary" ? "binary" : null;
  }
  if (product === "cli" && os === "windows") {
    return k === "binary" || k === "exe" ? "binary" : null;
  }
  return null;
}

export const DownloadParamsSchema = z.object({
  ref: RefSchema,
  product: ProductSchema,
  os: OsSchema,
  arch: ArchInputSchema,
  kind: KindInputSchema,
}).superRefine((p, ctx) => {
  const arch = ARCH_CANONICAL[p.arch] ?? p.arch;
  if (p.os === "macos") {
    if (arch !== "arm64") {
      ctx.addIssue({
        code: "custom",
        message: "macOS is arm64 (Apple Silicon) only",
      });
    }
  } else if (arch !== "amd64") {
    ctx.addIssue({
      code: "custom",
      message: `${p.os} arm64 is not available yet`,
    });
  }
  if (canonicalKind(p.product, p.os, p.kind) === null) {
    ctx.addIssue({
      code: "custom",
      message: `Unsupported kind "${p.kind}" for ${p.product}/${p.os}`,
    });
  }
}).transform((p) => ({
  ref: p.ref,
  product: p.product,
  os: p.os,
  arch: (ARCH_CANONICAL[p.arch] ?? p.arch) as "amd64" | "arm64",
  kind: canonicalKind(p.product, p.os, p.kind) as string,
}));
export type DownloadParams = z.infer<typeof DownloadParamsSchema>;

export const EnvSchema = z.object({
  GITHUB_TOKEN: z.string({ error: "GITHUB_TOKEN is required" }).min(
    1,
    "GITHUB_TOKEN is required",
  ),
  GITHUB_REPO: z.string().default("simtxng/transmitter-go"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8000),
  CACHE_DIR: z.string().min(1).default("./cache"),
  LATEST_TTL: z.coerce.number().nonnegative().default(60),
  TAG_TTL: z.coerce.number().nonnegative().default(300),
  TARGETS_TTL: z.coerce.number().nonnegative().default(300),
  PREFETCH: z.string().default("1").transform((v) => v !== "0"),
  REFRESH_INTERVAL: z.coerce.number().nonnegative().default(300),
  CACHE_MAX_RUNS: z.coerce.number().int().nonnegative().default(10),
  LINUX_WORKFLOW: z.string().min(1).default("build-linux.yml"),
  WINDOWS_WORKFLOW: z.string().min(1).default("build-windows.yml"),
  MACOS_WORKFLOW: z.string().min(1).default("build-macos.yml"),
  LATEST_REF: z.string().optional(),
  VERSION_RETURN: z.string().optional(),
  SIGNING_KEY_FILE: z.string().optional(),
});
export type Env = z.infer<typeof EnvSchema>;

export const AppOptionsSchema = z.object({
  repo: z.string().min(1),
  token: z.string().min(1),
  workflows: z.object({
    linux: z.string().min(1),
    windows: z.string().min(1),
    macos: z.string().min(1),
  }),
  cacheDir: z.string().min(1),
  latestTtlMs: z.number().finite().nonnegative(),
  tagTtlMs: z.number().finite().nonnegative(),
  targetsTtlMs: z.number().finite().nonnegative(),
  cacheMaxRuns: z.number().int().nonnegative(),
  latestRef: z.string().optional(),
  versionReturn: z.string().optional(),
  signingKey: z.string().optional(),
});
export type AppOptions = z.infer<typeof AppOptionsSchema>;

export const RunSchema = z.object({
  id: z.number(),
  head_branch: z.string(),
  head_sha: z.string(),
  run_number: z.number(),
  display_title: z.string(),
  name: z.string(),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Run = z.infer<typeof RunSchema>;

export const RunListSchema = z.object({
  workflow_runs: z.array(RunSchema),
});
export type RunList = z.infer<typeof RunListSchema>;

export const ArtifactsSchema = z.object({
  artifacts: z.array(
    z.object({ id: z.number(), expired: z.boolean() }),
  ),
});
export type Artifacts = z.infer<typeof ArtifactsSchema>;

export const TargetDefSchema = z.object({
  product: z.enum(["app", "cli"]),
  os: OsSchema,
  arch: z.enum(["amd64", "arm64"]),
  kind: z.string().min(1),
}).superRefine((t, ctx) => {
  const wantArch = t.os === "macos" ? "arm64" : "amd64";
  if (t.arch !== wantArch) {
    ctx.addIssue({
      code: "custom",
      message: `arch "${t.arch}" invalid for ${t.os}, want "${wantArch}"`,
    });
  }
  if (canonicalKind(t.product, t.os, t.kind) !== t.kind) {
    ctx.addIssue({
      code: "custom",
      message: `kind "${t.kind}" is not canonical for ${t.product}/${t.os}`,
    });
  }
});
export type TargetDef = z.infer<typeof TargetDefSchema>;
