/**
 * Repeatable latency benchmark for POST /v1/messages:batch (100 messages).
 *
 * Seeds a device credential with the contract test-vector key, then measures
 * signed request latency against a running API.
 *
 * Example:
 *   pnpm exec tsx bench/ingest-batch.ts \
 *     --base-url http://127.0.0.1:8080 \
 *     --host 127.0.0.1:8080 \
 *     --iterations 30 --warmup 5
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  buildCanonicalString,
  encodeBase64Url,
  sha256HexBytes,
  signEs256P1363,
} from "../src/device/signing.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testVector = JSON.parse(
  readFileSync(path.join(repoRoot, "docs/contracts/examples/test-vector.json"), "utf8"),
) as {
  testPrivateKeyPkcs8Pem: string;
  testPublicKeySpkiB64url: string;
};

type Args = {
  baseUrl: string;
  host: string;
  iterations: number;
  warmup: number;
  batchSize: number;
  databaseUrl: string;
};

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback?: string): string | undefined => {
    const idx = argv.indexOf(name);
    if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
    return fallback;
  };
  return {
    baseUrl: get("--base-url", "http://127.0.0.1:8080")!,
    host: get("--host", "127.0.0.1:8080")!,
    iterations: Number(get("--iterations", "30")),
    warmup: Number(get("--warmup", "5")),
    batchSize: Number(get("--batch-size", "100")),
    databaseUrl:
      get("--database-url") ??
      process.env.MIGRATE_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgres://sms:sms@127.0.0.1:5432/sms",
  };
}

function freshNonce(): string {
  return encodeBase64Url(Buffer.from(randomUUID().replace(/-/g, ""), "hex").subarray(0, 16));
}

function buildBatch(size: number, prefix: string): string {
  const messages = Array.from({ length: size }, (_, i) => ({
    device_msg_id: `${prefix}-${i}`,
    sender: "+15551234567",
    body: `bench message ${i}`,
    received_at: "2026-11-18T09:45:12Z",
    sim_slot: 0,
    direction: "inbound",
  }));
  return JSON.stringify({ messages });
}

function sign(opts: {
  method: string;
  path: string;
  host: string;
  deviceId: string;
  body: string;
}): Record<string, string> {
  const contentSha256 = sha256HexBytes(Buffer.from(opts.body, "utf8"));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = freshNonce();
  const canonical = buildCanonicalString({
    method: opts.method,
    path: opts.path,
    query: "",
    host: opts.host,
    deviceId: opts.deviceId,
    timestamp,
    contentSha256,
    nonce,
  });
  const signature = signEs256P1363(canonical, testVector.testPrivateKeyPkcs8Pem);
  return {
    host: opts.host,
    "content-type": "application/json",
    "x-device-id": opts.deviceId,
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "x-content-sha256": contentSha256,
    "x-signature": signature,
  };
}

async function seedDevice(databaseUrl: string): Promise<string> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, mfa_enrolled) VALUES ($1, true) RETURNING id`,
      [`bench-${randomUUID()}@example.com`],
    );
    const ownerId = user.rows[0]!.id;
    await pool.query(`UPDATE users SET owner_id = id WHERE id = $1`, [ownerId]);

    const device = await pool.query<{ id: string }>(
      `INSERT INTO devices (owner_id, name, platform_info, status)
       VALUES ($1, 'Bench Device', '{"platform":"android"}'::jsonb, 'active')
       RETURNING id`,
      [ownerId],
    );
    const deviceId = device.rows[0]!.id;
    await pool.query(
      `INSERT INTO device_credentials (owner_id, device_id, public_key)
       VALUES ($1, $2, $3)`,
      [ownerId, deviceId, testVector.testPublicKeySpkiB64url],
    );
    return deviceId;
  } finally {
    await pool.end();
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.batchSize > 100) {
    throw new Error("batch size must be <= 100 (contract limit)");
  }

  const health = await fetch(`${args.baseUrl}/healthz`);
  if (!health.ok) {
    throw new Error(`API not healthy at ${args.baseUrl}/healthz (${health.status})`);
  }

  const deviceId = await seedDevice(args.databaseUrl);
  console.log(
    JSON.stringify({
      event: "bench_start",
      baseUrl: args.baseUrl,
      host: args.host,
      deviceId,
      batchSize: args.batchSize,
      warmup: args.warmup,
      iterations: args.iterations,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
  );

  const samples: number[] = [];
  const total = args.warmup + args.iterations;

  for (let i = 0; i < total; i++) {
    const body = buildBatch(args.batchSize, `bench-${Date.now()}-${i}`);
    const headers = sign({
      method: "POST",
      path: "/v1/messages:batch",
      host: args.host,
      deviceId,
      body,
    });
    const t0 = performance.now();
    const res = await fetch(`${args.baseUrl}/v1/messages:batch`, {
      method: "POST",
      headers,
      body,
    });
    const ms = performance.now() - t0;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`iteration ${i} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { results: unknown[] };
    if (json.results.length !== args.batchSize) {
      throw new Error(`iteration ${i}: expected ${args.batchSize} results`);
    }
    if (i >= args.warmup) {
      samples.push(ms);
    }
    console.log(
      JSON.stringify({
        event: "sample",
        i,
        phase: i < args.warmup ? "warmup" : "measure",
        ms: Number(ms.toFixed(2)),
      }),
    );
  }

  samples.sort((a, b) => a - b);
  const summary = {
    event: "bench_summary",
    samples: samples.length,
    batchSize: args.batchSize,
    p50_ms: Number(percentile(samples, 50).toFixed(2)),
    p95_ms: Number(percentile(samples, 95).toFixed(2)),
    p99_ms: Number(percentile(samples, 99).toFixed(2)),
    mean_ms: Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2)),
    min_ms: Number(samples[0]!.toFixed(2)),
    max_ms: Number(samples[samples.length - 1]!.toFixed(2)),
  };
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
