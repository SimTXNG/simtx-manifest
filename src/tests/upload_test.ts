import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { parseUploadBody, parseUploadFilename } from "../uploads.ts";
import { HttpError } from "../validation.ts";
import { makeRun, req, runsResponse, testCtx } from "./util.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const put = (
  path: string,
  body: Uint8Array | string,
  token?: string,
  extraHeaders: Record<string, string> = {},
) => {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    ...extraHeaders,
  };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  const payload = typeof body === "string"
    ? body
    : new Blob([body as unknown as BlobPart]);
  return new Request(`http://localhost${path}`, {
    method: "PUT",
    headers,
    body: payload,
  });
};

const del = (path: string, token?: string) => {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return new Request(`http://localhost${path}`, { method: "DELETE", headers });
};

Deno.test("uploads: 503 when UPLOAD_TOKEN unset", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir);
    const res = await ctx.app.handle(
      put("/upload/latest/app/linux/amd64/deb", "x", "any"),
    );
    assertEquals(res.status, 503);
  });
});

Deno.test("uploads: 401 on missing/malformed/wrong token", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir, { uploadToken: "secret" });
    const noHeader = await ctx.app.handle(
      new Request("http://localhost/upload/latest/app/linux/amd64/deb", {
        method: "PUT",
        body: "x",
      }),
    );
    assertEquals(noHeader.status, 401);
    const wrong = await ctx.app.handle(
      put("/upload/latest/app/linux/amd64/deb", "x", "nope"),
    );
    assertEquals(wrong.status, 401);
    const badScheme = await ctx.app.handle(
      put("/upload/latest/app/linux/amd64/deb", "x", undefined, {
        authorization: "Token secret",
      }),
    );
    assertEquals(badScheme.status, 401);
  });
});

Deno.test("uploads: 422 on bad target, bad filename, empty body", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir, { uploadToken: "secret" });
    const badKind = await ctx.app.handle(
      put("/upload/latest/app/linux/amd64/zip", "x", "secret"),
    );
    assertEquals(badKind.status, 422);
    const badName = await ctx.app.handle(
      put(
        "/upload/latest/app/linux/amd64/deb?filename=evil.exe",
        "x",
        "secret",
      ),
    );
    assertEquals(badName.status, 422);
    const traversal = await ctx.app.handle(
      put(
        "/upload/latest/app/linux/amd64/deb?filename=../evil.deb",
        "x",
        "secret",
      ),
    );
    assertEquals(traversal.status, 422);
    const empty = await ctx.app.handle(
      put("/upload/latest/app/linux/amd64/deb", "", "secret"),
    );
    assertEquals(empty.status, 422);
  });
});

Deno.test("uploads: PUT then GET serves bytes + HEAD + range", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir, {
      uploadToken: "secret",
      fetchImpl: () => Promise.resolve(runsResponse([makeRun()])),
    });
    const body = new TextEncoder().encode("debian-package-bytes");
    const up = await ctx.app.handle(
      put(
        "/upload/v1.2.3/app/linux/amd64/deb?filename=simtx_1.2.3_amd64.deb",
        body,
        "secret",
      ),
    );
    assertEquals(up.status, 201);
    const payload = await up.json();
    assertEquals(payload.file, "simtx_1.2.3_amd64.deb");
    assertEquals(payload.size, body.length);

    const get = await ctx.app.handle(req("/v1.2.3/app/linux/amd64/deb"));
    assertEquals(get.status, 200);
    assertEquals(await get.text(), "debian-package-bytes");
    assertEquals(get.headers.get("x-release-ref"), "v1.2.3");

    const head = await ctx.app.handle(
      req("/v1.2.3/app/linux/amd64/deb", { method: "HEAD" }),
    );
    assertEquals(head.status, 200);
    assertEquals(head.headers.get("content-length"), String(body.length));

    const range = await ctx.app.handle(
      req("/v1.2.3/app/linux/amd64/deb", { headers: { range: "bytes=0-6" } }),
    );
    assertEquals(range.status, 206);
    assertEquals(await range.text(), "debian-");
  });
});

Deno.test("uploads: shadow GitHub artifact + appear in /api/targets", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir, {
      uploadToken: "secret",
      versionReturn: "9.9.9",
      fetchImpl: () => Promise.resolve(runsResponse([])),
    });
    // No GitHub runs at all: without upload this would 404.
    const before = await ctx.app.handle(req("/latest/app/linux/amd64/deb"));
    assertEquals(before.status, 404);

    await ctx.app.handle(
      put(
        "/upload/latest/app/linux/amd64/deb?filename=simtx_9.9.9_amd64.deb",
        "uploaded!",
        "secret",
      ),
    );
    const after = await ctx.app.handle(req("/latest/app/linux/amd64/deb"));
    assertEquals(after.status, 200);
    assertEquals(await after.text(), "uploaded!");

    const targets = await (await ctx.app.handle(req("/api/targets/latest")))
      .json();
    const deb = targets.targets.find(
      (t: { kind: string; os: string }) => t.kind === "deb" && t.os === "linux",
    );
    assertEquals(deb.available, true);
    assertEquals(deb.file, "simtx_9.9.9_amd64.deb");
  });
});

Deno.test("uploads: DELETE removes file, second DELETE 404s", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir, {
      uploadToken: "secret",
      fetchImpl: () => Promise.resolve(runsResponse([])),
    });
    await ctx.app.handle(
      put("/upload/latest/cli/linux/amd64/binary", "cli-bytes", "secret"),
    );
    const get = await ctx.app.handle(req("/latest/cli/linux/amd64/binary"));
    assertEquals(get.status, 200);

    const gone = await ctx.app.handle(
      del("/upload/latest/cli/linux/amd64/binary", "secret"),
    );
    assertEquals(gone.status, 200);
    assertEquals((await gone.json()).deleted, ["simtx-cli"]);

    const after = await ctx.app.handle(req("/latest/cli/linux/amd64/binary"));
    assertEquals(after.status, 404);

    const again = await ctx.app.handle(
      del("/upload/latest/cli/linux/amd64/binary", "secret"),
    );
    assertEquals(again.status, 404);
  });
});

Deno.test("uploads: 413 when over UPLOAD_MAX_BYTES", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir, { uploadToken: "secret", uploadMaxBytes: 4 });
    const res = await ctx.app.handle(
      put("/upload/latest/app/linux/amd64/deb", "12345", "secret"),
    );
    assertEquals(res.status, 413);
  });
});

Deno.test("uploads: default filename satisfies matcher (cli + deb)", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir, { uploadToken: "secret" });
    const cli = await ctx.app.handle(
      put("/upload/latest/cli/linux/amd64/binary", "c", "secret"),
    );
    assertEquals(cli.status, 201);
    assertEquals((await cli.json()).file, "simtx-cli");
    const deb = await ctx.app.handle(
      put("/upload/latest/app/linux/amd64/deb", "d", "secret"),
    );
    assertEquals(deb.status, 201);
    assertStringIncludes((await deb.json()).file, ".deb");
  });
});

Deno.test("uploads: GET /api/uploads lists + requires auth", async () => {
  await withTempDir(async (dir) => {
    const ctx = testCtx(dir, { uploadToken: "secret" });
    const anon = await ctx.app.handle(req("/api/uploads/latest"));
    assertEquals(anon.status, 401);
    await ctx.app.handle(
      put(
        "/upload/latest/app/linux/amd64/deb?filename=a_amd64.deb",
        "d",
        "secret",
      ),
    );
    const listed = await ctx.app.handle(
      req("/api/uploads/latest", {
        headers: { authorization: "Bearer secret" },
      }),
    );
    assertEquals(listed.status, 200);
    const body = await listed.json();
    assertEquals(body.ref, "latest");
    assertEquals(body.uploads.length, 1);
    assertEquals(body.uploads[0].file, "a_amd64.deb");
  });
});

Deno.test("uploads module: zod filename/body schemas", () => {
  const debOnly = (_p: string, _o: string, _k: string, n: string) =>
    n.endsWith(".deb");
  assertEquals(
    parseUploadFilename(null, "app", "linux", "deb", debOnly),
    "upload.deb",
  );
  assertEquals(
    parseUploadFilename("simtx_1_amd64.deb", "app", "linux", "deb", debOnly),
    "simtx_1_amd64.deb",
  );
  for (const bad of ["../x.deb", "a/b.deb", "a\\b.deb", "evil.exe", "", ".."]) {
    const err = assertThrows(
      () => parseUploadFilename(bad, "app", "linux", "deb", debOnly),
      HttpError,
      undefined,
      JSON.stringify(bad),
    );
    assertEquals((err as HttpError).status, 422, JSON.stringify(bad));
  }
  assertEquals(parseUploadBody(new TextEncoder().encode("x")).length, 1);
  const empty = assertThrows(
    () => parseUploadBody(new Uint8Array(0)),
    HttpError,
    "empty upload body",
  );
  assertEquals((empty as HttpError).status, 422);
});
