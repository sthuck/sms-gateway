import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/composition/build-app.js";
import { loadConfig } from "../../src/config.js";

const INDEX_HTML = '<!doctype html><html><body><div id="root">SMS Gateway</div></body></html>\n';
const APP_JS = "console.log('sms-gateway');\n";
const STYLE_CSS = "body { margin: 0; }\n";
const FAVICON_BYTES = Buffer.from([0x00, 0x00, 0x01, 0x00]);

function expectProblem(
  res: { statusCode: number; headers: Record<string, unknown>; json: () => unknown },
  expectedStatus: number,
  expectedCode: string,
): void {
  expect(res.statusCode).toBe(expectedStatus);
  expect(String(res.headers["content-type"] ?? "")).toContain("application/problem+json");
  expect((res.json() as { code: string }).code).toBe(expectedCode);
}

describe("webStaticPlugin", () => {
  let tmpBase: string;
  let fixtureDir: string;
  let emptyDir: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "sms-gw-web-static-"));
    fixtureDir = path.join(tmpBase, "dist");
    emptyDir = path.join(tmpBase, "empty");
    fs.mkdirSync(path.join(fixtureDir, "assets"), { recursive: true });
    fs.mkdirSync(emptyDir, { recursive: true });

    fs.writeFileSync(path.join(fixtureDir, "index.html"), INDEX_HTML);
    fs.writeFileSync(path.join(fixtureDir, "assets", "app-abc123.js"), APP_JS);
    fs.writeFileSync(path.join(fixtureDir, "assets", "style-def456.css"), STYLE_CSS);
    fs.writeFileSync(path.join(fixtureDir, "favicon.ico"), FAVICON_BYTES);
    fs.writeFileSync(path.join(fixtureDir, ".env"), "SECRET=nope\n");

    const outsideFile = path.join(tmpBase, "outside.txt");
    fs.writeFileSync(outsideFile, "outside secret\n");
    fs.symlinkSync(outsideFile, path.join(fixtureDir, "escape.txt"));

    const config = loadConfig({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "8080",
      LOG_LEVEL: "silent",
    });
    app = await buildApp(config, { webDistDir: fixtureDir });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (tmpBase) {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("serves index.html on GET / and HEAD / with no-cache and HTML security headers", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(typeof res.headers.etag).toBe("string");
    expect(res.body).toBe(INDEX_HTML);

    const head = await app.inject({ method: "HEAD", url: "/" });
    expect(head.statusCode).toBe(200);
    expect(head.headers.etag).toBe(res.headers.etag);
    expect(Number(head.headers["content-length"])).toBe(Buffer.byteLength(INDEX_HTML));
    expect(head.body).toBe("");
  });

  it("returns 304 when If-None-Match matches exact or weak ETag", async () => {
    const initial = await app.inject({ method: "GET", url: "/" });
    const etag = String(initial.headers.etag);

    const exact = await app.inject({
      method: "GET",
      url: "/",
      headers: { "if-none-match": etag },
    });
    expect(exact.statusCode).toBe(304);
    expect(exact.body).toBe("");

    const weak = await app.inject({
      method: "GET",
      url: "/",
      headers: { "if-none-match": `W/${etag}` },
    });
    expect(weak.statusCode).toBe(304);
    expect(weak.body).toBe("");
  });

  it("serves hashed assets with immutable caching and non-HTML files with standard headers", async () => {
    const js = await app.inject({ method: "GET", url: "/assets/app-abc123.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(js.headers["x-content-type-options"]).toBe("nosniff");
    expect(js.headers["x-frame-options"]).toBeUndefined();
    expect(js.body).toBe(APP_JS);

    const css = await app.inject({ method: "GET", url: "/assets/style-def456.css" });
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(css.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(css.body).toBe(STYLE_CSS);

    const ico = await app.inject({ method: "GET", url: "/favicon.ico" });
    expect(ico.statusCode).toBe(200);
    expect(ico.headers["content-type"]).toBe("image/x-icon");
    expect(ico.headers["cache-control"]).toBe("public, max-age=3600");
    expect(ico.rawPayload).toEqual(FAVICON_BYTES);
  });

  it("falls back to index.html for SPA routes while preserving health and API 404s", async () => {
    for (const spaPath of [
      "/login",
      "/inbox",
      "/inbox/00000000-0000-4000-8000-000000000001",
      "/devices/pair",
      "/tokens",
    ]) {
      const res = await app.inject({ method: "GET", url: spaPath });
      expect(res.statusCode, spaPath).toBe(200);
      expect(res.headers["content-type"], spaPath).toBe("text/html; charset=utf-8");
      expect(res.headers["cache-control"], spaPath).toBe("no-cache");
      expect(res.headers["x-frame-options"], spaPath).toBe("DENY");
      expect(res.body, spaPath).toBe(INDEX_HTML);
    }

    const jsonAccept = await app.inject({
      method: "GET",
      url: "/inbox",
      headers: { accept: "application/json" },
    });
    expectProblem(jsonAccept, 404, "not_found");

    for (const apiMissing of [
      { method: "GET" as const, url: "/v1/does-not-exist" },
      { method: "GET" as const, url: "/v1" },
      { method: "POST" as const, url: "/v1/does-not-exist" },
    ]) {
      const res = await app.inject(apiMissing);
      expectProblem(res, 404, "not_found");
    }

    const healthz = await app.inject({ method: "GET", url: "/healthz" });
    expect(healthz.statusCode).toBe(200);
    expect(healthz.json()).toEqual({ status: "ok" });

    const readyz = await app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(200);
    expect(readyz.json()).toEqual({ status: "ready" });
  });

  it("rejects missing assets, hidden files, symlinks, traversal, bad encoding, and non-GET methods", async () => {
    for (const blockedPath of [
      "/assets/missing.js",
      "/missing.css",
      "/.env",
      "/escape.txt",
      "/%2e%2e/outside.txt",
      "/../outside.txt",
    ]) {
      const res = await app.inject({ method: "GET", url: blockedPath });
      expectProblem(res, 404, "not_found");
    }

    const malformed = await app.inject({ method: "GET", url: "/%E0%A4%A" });
    expect(malformed.statusCode).toBe(400);
    expect((malformed.json() as { code: string }).code).toBe("FST_ERR_BAD_URL");
    expect(malformed.body).not.toContain("SMS Gateway");

    const postInbox = await app.inject({ method: "POST", url: "/inbox" });
    expectProblem(postInbox, 404, "not_found");

    const deleteRoot = await app.inject({ method: "DELETE", url: "/" });
    expectProblem(deleteRoot, 404, "not_found");
  });

  it("fails fast at startup when WEB_DIST_DIR is missing or lacks index.html, and stays disabled when null", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "8080",
      LOG_LEVEL: "silent",
    });

    await expect(
      buildApp(config, { webDistDir: path.join(tmpBase, "does-not-exist") }),
    ).rejects.toThrow(/not a readable directory/);

    await expect(buildApp(config, { webDistDir: emptyDir })).rejects.toThrow(/missing index\.html/);

    const disabledApp = await buildApp(config, { webDistDir: null });
    await disabledApp.ready();
    try {
      const res = await disabledApp.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(404);
    } finally {
      await disabledApp.close();
    }
  });
});
