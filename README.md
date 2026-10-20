# simtx-manifest

Serves simtx build artifacts uploaded by CI as plain download links. One landing page lists every build, and each file gets a stable URL.

Deno runs the server. Elysia handles routing and Zod checks every input. CI pushes files with an authenticated `PUT`; the server stores them under `<CACHE_DIR>/uploads` and serves them from disk. Uploaded files are the only artifact source.

## Quick start

```sh
cp .env.example .env
# set UPLOAD_TOKEN in .env
deno task dev
```

Open http://127.0.0.1:8000. For production without file watching, run `deno task prod` instead.

Uploads are disabled until `UPLOAD_TOKEN` is set, but downloads and the landing page still work.

## Download URLs

Canonical shape, five segments:

```text
/<ref>/<app|cli>/<linux|windows|macos>/<amd64|arm64>/<kind>
/latest/app/linux/amd64/deb
/v1.2.3/cli/windows/amd64/binary
```

Kinds per platform: `deb`, `rpm`, `xbps`, `pkg.zst`, `pkg.zst.sig`, `appimage`, `appimage-zsync`, `appimage-sha256` on Linux; `exe` on Windows; `dmg` on macOS (Apple Silicon only). The CLI ships as `binary`. Aliases work too: `x86_64` for `amd64`, `aarch64` for `arm64`, `pkg.tar.zst` and `arch` for `pkg.zst`.

A legacy four-segment form still works for the desktop app:

```text
/<ref>/<os>/<arch>/<kind>
/latest/linux/amd64/deb
```

Other routes:

```text
GET  /                    landing page
GET  /install             install instructions (repos, AppImage, CLI)
GET  /pubkey              package-signing public key (application/pgp-keys)
GET  /dists/stable/...    APT repo (InRelease, Release[.gpg], Packages[.gz])
GET  /pool/main/*.deb     APT pool (conventional filename, immutable)
GET  /arch/x86_64/...     Arch repo (simtx.db[.tar.gz][.sig], simtx.files...)
GET  /rpmrepo/...         Fedora repo (repodata/, pool rpm)
GET  /xbps/...            Void repo (x86_64-repodata, *.xbps[.sig2])
GET  /xbps/pubkey         XBPS RSA public key + fingerprint headers
GET  /api/latest          newest upload per platform, as JSON
GET  /api/targets[/ref]   which downloads exist for a ref, as JSON
GET  /api/uploads/:ref    uploaded binaries for a ref, as JSON (Bearer auth)
PUT  /upload/<ref>/<app|cli>/<linux|windows|macos>/<amd64|arm64>/<kind>[?filename=]
DELETE /upload/<ref>/<app|cli>/<linux|windows|macos>/<amd64|arm64>/<kind>
GET  /healthz             liveness probe, answers ok
GET  /version             VERSION_RETURN value, else newest uploaded version-like ref (503 when neither works)
```

HEAD works everywhere GET does. Bad input answers 422 with the validation details. A ref with no uploaded file answers 404.

## Configuration

All settings come from the environment, validated on startup. Copy `.env.example` to `.env` and edit it. Unknown variables are ignored, so obsolete CI settings in an existing `.env` are harmless but can be removed.

| Variable | Default | What it does |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8000` | Bind address and port |
| `CACHE_DIR` | `./cache` | Where uploaded artifacts live on disk |
| `TAG_TTL` / `TARGETS_TTL` | `300` / `300` | In-memory cache lifetimes in seconds |
| `VERSION_RETURN` | (unset) | String returned by `/version` (and `version` in `/api/latest`, `/api/targets`, `/api/updates/latest`); when unset the newest uploaded version-like ref is used with one leading `v`/`V` stripped (`v0.1.0-alpha-5` → `0.1.0-alpha-5`), cached for `TAG_TTL` seconds, 503 if none exists |
| `SIGNING_KEY_FILE` | (unset) | Armored private key for APT/Arch/RPM metadata (chmod 600, never commit). Unset means repo metadata routes answer 503; packages still serve |
| `XBPS_SIGNING_KEY_FILE` | (unset) | RSA private key for the XBPS repo (PKCS#1 or PKCS#8 PEM, chmod 600, never commit). Unset means `/xbps` repo routes answer 503; direct `.xbps` downloads still work |
| `XBPS_SIGNED_BY` | `SimTX XBPS Repository <packages@simtx.net>` | `signature-by` value embedded in XBPS repodata |
| `XBPS_PASSPHRASE` | (unset) | Passphrase for an encrypted XBPS RSA private key |
| `UPLOAD_TOKEN` | (unset) | Bearer token guarding `PUT`/`DELETE /upload/...` and `GET /api/uploads/:ref`; unset means uploads answer 503 (disabled) |
| `UPLOAD_MAX_MB` | `500` | Max bytes accepted for one upload |

Bad values fail fast with the exact problem printed, instead of silently running on `NaN`.

### XBPS repository key

XBPS repositories require RSA, so they use a separate key from the Ed25519
APT/Arch/RPM signing key. Generate a PKCS#1 PEM key and point the server at it:

```sh
ssh-keygen -t rsa -b 4096 -m PEM -f xbps-signing.key -N ""
chmod 600 xbps-signing.key
# .env
# XBPS_SIGNING_KEY_FILE="./xbps-signing.key"
# XBPS_SIGNED_BY="SimTX XBPS Repository <packages@simtx.net>"
```

The public half is embedded in `x86_64-repodata`; `.xbps.sig2` files are
generated on demand from the same key. `GET /xbps/pubkey` serves the public
PEM with its lowercase OpenSSH-style MD5 fingerprint in the `X-XBPS-Fingerprint` header.
Never commit the private key (`xbps-signing.key` is gitignored).

## Uploading binaries

CI pushes binaries with an authenticated `PUT`. One request carries one file as
raw bytes; the URL path already identifies the target, and `?filename=` (or
`X-Filename` header) sets the stored name. Omit it for a sensible default
(`simtx-cli`, `upload.deb`, ...). The filename must match the target (a `.exe`
is rejected for a `deb` slot, `../` and `/` are rejected).

```sh
curl -T ./simtx_0.1.0_amd64.deb \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  "http://127.0.0.1:8000/upload/latest/app/linux/amd64/deb?filename=simtx_0.1.0_amd64.deb"
curl -X DELETE -H "Authorization: Bearer $UPLOAD_TOKEN" \
  "http://127.0.0.1:8000/upload/latest/app/linux/amd64/deb"
```

Uploads land under `<CACHE_DIR>/uploads/<ref>/...` and are the source for
download routes, `/api/targets`, `/api/latest`, and the APT/Arch/RPM/XBPS repo
builders. CircleCI uploads each built artifact under the tag ref and `latest`.
Uploading invalidates the cached target/repo metadata for that ref. A successful
`PUT` answers `201` with
`{ref, product, os, arch, kind, file, size, sha256}`. Auth failures answer
`401`, oversized bodies `413`, disabled uploads `503`.

## How it works

The upload store is the source of truth. There are no CI provider API calls. A request for `/latest/...` or `/<tag>/...` reads the matching file from
`cache/uploads/<ref>/...`; repo metadata is built from those same files and
cached in memory. Pinned refs get long-lived cache headers, `latest` is
revalidated. Old uploads are kept until removed with `DELETE`.

## Tests

```sh
deno task test
```

Suites live in `src/tests/`: route behavior, upload store behavior, input validation, and the pure helpers. They run against `app.handle()` in memory with temp upload directories, so no token or network access is needed.

## Project layout

```text
src/index.ts      env parsing, Deno.serve
src/app.ts        Elysia routes, uploads-only artifact reads
src/uploads.ts    authenticated direct-upload store + handlers (Zod-validated)
src/validation.ts Zod schemas for params, config, and API payloads
src/repo-plist.ts XML plist parser/serializer (XBPS metadata)
src/repo-xbps.ts  XBPS repodata, props parsing, RSA signing
src/tests/        one suite per area above
src/static/index.html landing page
```
