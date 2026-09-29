# simtx-manifest

Serves simtx build artifacts straight from GitHub Actions as plain download links. One landing page lists every build, and each file gets a stable URL.

Deno runs the server. Elysia handles routing, Zod checks every input, and fflate pulls the wanted files out of artifact zips. Downloads land in a local cache dir, so repeat requests come from disk.

## Quick start

```sh
cp .env.example .env
# put a real token in .env (it needs Actions: read)
deno task dev
```

Open http://127.0.0.1:8000. For production without file watching, run `deno task prod` instead.

Artifact zips need auth even on public repos, so `GITHUB_TOKEN` is required. The server exits on startup if it is missing or invalid.

## Download URLs

Canonical shape, five segments:

```text
/<ref>/<app|cli>/<linux|windows|macos>/<amd64|arm64>/<kind>
/latest/app/linux/amd64/deb
/v1.2.3/cli/windows/amd64/binary
```

Kinds per platform: `deb`, `rpm`, `pkg.zst`, `pkg.zst.sig`, `appimage`, `appimage-zsync`, `appimage-sha256` on Linux; `exe` on Windows; `dmg` on macOS (Apple Silicon only). The CLI ships as `binary`. Aliases work too: `x86_64` for `amd64`, `aarch64` for `arm64`, `pkg.tar.zst` and `arch` for `pkg.zst`.

A legacy four-segment form still works for the desktop app:

```text
/<ref>/<os>/<arch>/<kind>
/latest/linux/amd64/deb
```

Other routes:

```text
GET  /                    landing page
GET  /pubkey              package-signing public key (application/pgp-keys)
GET  /dists/stable/...    APT repo (InRelease, Release[.gpg], Packages[.gz])
GET  /pool/main/*.deb     APT pool (conventional filename, immutable)
GET  /arch/x86_64/...     Arch repo (simtx.db[.tar.gz][.sig], simtx.files...)
GET  /rpmrepo/...         Fedora repo (repodata/, pool rpm)
GET  /api/latest          newest build per platform, as JSON
GET  /api/targets[/ref]   which downloads exist for a ref, as JSON
GET  /healthz             liveness probe, answers ok
GET  /version             VERSION_RETURN value, 503 when unset
```

HEAD works everywhere GET does. Bad input answers 422 with the validation details. A ref with no successful build, or an artifact missing the file, answers 404.

## Configuration

All settings come from the environment, validated on startup. Copy `.env.example` to `.env` and edit it.

| Variable | Default | What it does |
|---|---|---|
| `GITHUB_TOKEN` | (required) | Token with Actions read access |
| `GITHUB_REPO` | `simtxng/transmitter-go` | Repo holding the build workflows |
| `HOST` / `PORT` | `0.0.0.0` / `8000` | Bind address and port |
| `CACHE_DIR` | `./cache` | Where extracted artifacts live on disk |
| `LINUX_WORKFLOW` / `WINDOWS_WORKFLOW` / `MACOS_WORKFLOW` | `build-linux.yml` etc. | Workflow file per platform |
| `LATEST_REF` | (unset) | Pin `latest` to one branch or tag; unset means newest run on any ref |
| `LATEST_TTL` / `TAG_TTL` / `TARGETS_TTL` | `60` / `300` / `300` | In-memory cache lifetimes in seconds |
| `PREFETCH` | `1` | Warm the cache on startup; `0` disables it |
| `REFRESH_INTERVAL` | `300` | Seconds between background refreshes; `0` disables them |
| `CACHE_MAX_RUNS` | `10` | Old run dirs past this count get pruned; `0` keeps everything |
| `VERSION_RETURN` | (unset) | String returned by `/version` |

Bad values fail fast with the exact problem printed, instead of silently running on `NaN`.

## How it works

GitHub stays the source of truth. The server asks the Actions API for the newest successful run of each platform workflow, downloads the artifact zip, extracts the wanted files, and stores them under `cache/<run id>`. Responses go out with download headers and long-lived cache headers for pinned refs.

On startup it prefetches `latest` for all three platforms in the background, then re-checks every `REFRESH_INTERVAL` seconds. Serving never waits on that work.

## Tests

```sh
deno task test
```

Suites live in `src/tests/`: route behavior, GitHub API handling, cache pruning, zip extraction, input validation, and the pure helpers. They run against `app.handle()` in memory with a stubbed fetch, so no token or network access is needed.

## Project layout

```text
src/index.ts      env parsing, cache warmup, Deno.serve
src/app.ts        Elysia routes, GitHub layer, on-disk cache
src/validation.ts Zod schemas for params, config, and API payloads
src/tests/        one suite per area above
src/static/index.html landing page
```
