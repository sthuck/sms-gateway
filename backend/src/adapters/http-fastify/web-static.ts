import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { sendProblem } from "./problems.js";

export type StaticAsset = {
  filePath: string;
  urlPath: string;
  contentType: string;
  etag: string;
  size: number;
  immutable: boolean;
};

export type StaticManifest = {
  rootDir: string;
  assets: ReadonlyMap<string, StaticAsset>;
  indexAsset: StaticAsset;
};

export type WebStaticPluginOptions = {
  rootDir: string;
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function collectFiles(rootDir: string, currentDir: string, out: Map<string, StaticAsset>): void {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
      continue;
    }
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(rootDir, fullPath, out);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const rel = path.relative(rootDir, fullPath).split(path.sep).join("/");
    const urlPath = `/${rel}`;
    const bytes = fs.readFileSync(fullPath);
    const etag = `"${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}"`;
    out.set(urlPath, {
      filePath: fullPath,
      urlPath,
      contentType: contentTypeFor(fullPath),
      etag,
      size: bytes.byteLength,
      immutable: urlPath.startsWith("/assets/"),
    });
  }
}

/**
 * Index built web UI assets under `rootDir` at startup so runtime lookups are
 * confined to regular non-hidden files inside the bundle.
 */
export function loadStaticManifest(rootDir: string): StaticManifest {
  const resolvedRoot = path.resolve(rootDir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedRoot);
  } catch {
    throw new Error(`WEB_DIST_DIR is not a readable directory: ${resolvedRoot}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`WEB_DIST_DIR is not a readable directory: ${resolvedRoot}`);
  }

  const assets = new Map<string, StaticAsset>();
  collectFiles(resolvedRoot, resolvedRoot, assets);

  const indexAsset = assets.get("/index.html");
  if (!indexAsset) {
    throw new Error(`WEB_DIST_DIR is missing index.html: ${resolvedRoot}`);
  }

  return {
    rootDir: resolvedRoot,
    assets,
    indexAsset,
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value;
}

function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) {
    return false;
  }
  const trimmed = header.trim();
  if (trimmed === "*") {
    return true;
  }
  for (const part of trimmed.split(",")) {
    const candidate = part.trim().replace(/^W\//, "");
    if (candidate === etag) {
      return true;
    }
  }
  return false;
}

function sendAsset(request: FastifyRequest, reply: FastifyReply, asset: StaticAsset): FastifyReply {
  const isHtml = asset.urlPath === "/index.html" || asset.contentType.startsWith("text/html");
  const cacheControl = asset.immutable
    ? "public, max-age=31536000, immutable"
    : isHtml
      ? "no-cache"
      : "public, max-age=3600";

  void reply.header("etag", asset.etag);
  void reply.header("cache-control", cacheControl);
  void reply.header("x-content-type-options", "nosniff");
  if (isHtml) {
    void reply.header("referrer-policy", "no-referrer");
    void reply.header("x-frame-options", "DENY");
  }

  const ifNoneMatch = headerValue(request.headers["if-none-match"]);
  if (matchesIfNoneMatch(ifNoneMatch, asset.etag)) {
    return reply.status(304).send();
  }

  void reply.header("content-type", asset.contentType);
  void reply.header("content-length", asset.size);

  if (request.method === "HEAD") {
    return reply.status(200).send();
  }

  return reply.status(200).send(fs.createReadStream(asset.filePath));
}

function isReservedApiPath(decodedPath: string): boolean {
  return (
    decodedPath === "/v1" ||
    decodedPath.startsWith("/v1/") ||
    decodedPath === "/healthz" ||
    decodedPath === "/readyz"
  );
}

function isRejectedStaticOrTraversalPath(decodedPath: string): boolean {
  return (
    decodedPath.includes("\0") ||
    decodedPath.includes("\\") ||
    decodedPath.split("/").includes("..") ||
    decodedPath === "/assets" ||
    decodedPath.startsWith("/assets/") ||
    /\.[a-z0-9]{1,10}$/i.test(decodedPath)
  );
}

async function webStaticPluginImpl(
  app: FastifyInstance,
  opts: WebStaticPluginOptions,
): Promise<void> {
  const manifest = loadStaticManifest(opts.rootDir);

  app.setNotFoundHandler(async (request, reply) => {
    const rawPath = request.url.split("?")[0] ?? request.url;
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      return sendProblem(reply, "invalid_request", 400, "Malformed request path", {
        instance: rawPath,
      });
    }

    if (isReservedApiPath(decodedPath)) {
      return sendProblem(reply, "not_found", 404, "Not found", { instance: rawPath });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendProblem(reply, "not_found", 404, "Not found", { instance: rawPath });
    }

    const lookupPath = decodedPath === "/" ? "/index.html" : decodedPath;
    const exactAsset = manifest.assets.get(lookupPath);
    if (exactAsset) {
      return sendAsset(request, reply, exactAsset);
    }

    if (isRejectedStaticOrTraversalPath(decodedPath)) {
      return sendProblem(reply, "not_found", 404, "Not found", { instance: rawPath });
    }

    const accept = headerValue(request.headers.accept)?.trim();
    if (accept) {
      const lower = accept.toLowerCase();
      if (!lower.includes("text/html") && !lower.includes("*/*")) {
        return sendProblem(reply, "not_found", 404, "Not found", { instance: rawPath });
      }
    }

    return sendAsset(request, reply, manifest.indexAsset);
  });
}

export const webStaticPlugin = fp(webStaticPluginImpl, {
  name: "sms-gateway-web-static",
});
