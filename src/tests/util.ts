import { createApp, type AppOptions, type Run } from "../app.ts";

export function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 1,
    head_branch: "main",
    head_sha: "abcdef1234567890",
    run_number: 7,
    display_title: "Some PR",
    name: "workflow-name",
    html_url: "https://github.com/o/r/actions/runs/1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

export function runsResponse(runs: Run[]): Response {
  return new Response(JSON.stringify({ workflow_runs: runs }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function baseOpts(
  cacheDir: string,
  extra: Partial<AppOptions> = {},
): AppOptions {
  return {
    repo: "o/r",
    token: "test-token",
    workflows: {
      linux: "build-linux.yml",
      windows: "build-windows.yml",
      macos: "build-macos.yml",
    },
    cacheDir,
    latestTtlMs: 60_000,
    tagTtlMs: 300_000,
    targetsTtlMs: 300_000,
    cacheMaxRuns: 10,
    fetchImpl: () => {
      throw new Error("network should be stubbed in tests");
    },
    ...extra,
  };
}

export function testCtx(cacheDir: string, extra: Partial<AppOptions> = {}) {
  return createApp(baseOpts(cacheDir, extra));
}

export function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}
