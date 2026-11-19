import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "../../src/app.js";
import { loadConfig, parseTrustProxy } from "../../src/config.js";
import {
  appDatabaseUrl,
  canConnect,
  createAdminPool,
  createAppPool,
  migrateDatabaseUrl,
  resetSchema,
  runMigrations,
} from "../helpers/pg.js";
import { signDeviceRequest, testVector } from "../helpers/device-signing.js";

const migratorOk = await canConnect(migrateDatabaseUrl());
if (!migratorOk && process.env.CI === "true") {
  throw new Error(`Postgres migrator unreachable at ${migrateDatabaseUrl()}`);
}

const HOST = "10.0.2.2:8080";
const SPOOFED = "198.51.100.77";
const PROXY = "10.0.0.5";
const PEER = "192.0.2.10";
const INTERMEDIATE = "203.0.113.50";

describe("parseTrustProxy", () => {
  it("parses false / empty / 0 as trust nothing", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("0")).toBe(false);
  });

  it("parses true as boolean true only via the word true", () => {
    expect(parseTrustProxy("true")).toBe(true);
  });

  it("parses digit strings as hop counts (STH-42: 1 is not true)", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("1")).not.toBe(true);
  });

  it("parses a single IP and a CIDR list", () => {
    expect(parseTrustProxy("10.0.0.5")).toBe("10.0.0.5");
    expect(parseTrustProxy("10.0.0.5,10.0.0.0/8")).toEqual(["10.0.0.5", "10.0.0.0/8"]);
  });

  it("rejects invalid input", () => {
    expect(() => parseTrustProxy("yes")).toThrow(/Invalid TRUST_PROXY/);
    expect(() => parseTrustProxy("no")).toThrow(/Invalid TRUST_PROXY/);
    expect(() => parseTrustProxy("not-an-ip")).toThrow(/Invalid TRUST_PROXY/);
    expect(() => parseTrustProxy("10.0.0.5,bogus")).toThrow(/Invalid TRUST_PROXY/);
    expect(() => loadConfig({ TRUST_PROXY: "yes" })).toThrow(/Invalid configuration/);
  });

  it("warns in production when TRUST_PROXY=true", () => {
    const warn = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      const config = loadConfig({
        NODE_ENV: "production",
        TRUST_PROXY: "true",
        ENCRYPTION_ENABLED: "false",
      });
      expect(config.trustProxy).toBe(true);
      expect(calls.some((c) => String(c[0]).includes("TRUST_PROXY=true"))).toBe(true);
    } finally {
      console.warn = warn;
    }
  });
});

describe.skipIf(!migratorOk)("trustProxy vs spoofed X-Forwarded-For (STH-38/42)", () => {
  let admin: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    admin = createAdminPool();
    await resetSchema(admin);
    await runMigrations("up");
    appPool = createAppPool();
  }, 120_000);

  afterAll(async () => {
    await appPool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  async function build(trustProxy: string): Promise<FastifyInstance> {
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: appDatabaseUrl(),
      DEVICE_ALLOWED_HOSTS: HOST,
      TRUST_PROXY: trustProxy,
      PAIR_RATE_LIMIT_PER_IP: "100",
    });
    const app = await buildApp(config, {
      pool: appPool,
      auth: { config: null, skipDiscovery: true },
      deviceAuth: config.deviceAuth,
    });
    await app.ready();
    return app;
  }

  async function hitPair(
    app: FastifyInstance,
    opts: { remoteAddress: string; xff?: string },
  ): Promise<void> {
    const pairBody = {
      pairing_code: "ZZZZ-ZZZZ",
      alg: "ES256",
      public_key: testVector.testPublicKeySpkiB64url,
      device_info: { platform: "android", app_version: "1.0.0" },
    };
    const raw = JSON.stringify(pairBody);
    const signed = signDeviceRequest({
      method: "POST",
      path: "/v1/devices/pair",
      host: HOST,
      deviceId: "",
      body: raw,
    });
    const headers: Record<string, string> = { ...signed.headers };
    if (opts.xff) headers["x-forwarded-for"] = opts.xff;
    await app.inject({
      method: "POST",
      url: "/v1/devices/pair",
      headers,
      payload: raw,
      remoteAddress: opts.remoteAddress,
    });
  }

  async function bucketHits(ip: string): Promise<number> {
    const { rows } = await appPool.query<{ hit_count: number }>(
      `SELECT hit_count FROM app.rate_limit_buckets WHERE bucket_key = $1`,
      [`pair:ip:${ip}`],
    );
    return rows[0]?.hit_count ?? 0;
  }

  it("ignores spoofed X-Forwarded-For when TRUST_PROXY is false (default)", async () => {
    await appPool.query(`DELETE FROM app.rate_limit_buckets`);
    const app = await build("false");
    try {
      await hitPair(app, { remoteAddress: PEER, xff: SPOOFED });
      expect(await bucketHits(PEER)).toBeGreaterThanOrEqual(1);
      expect(await bucketHits(SPOOFED)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("honours X-Forwarded-For when the immediate peer is in TRUST_PROXY", async () => {
    await appPool.query(`DELETE FROM app.rate_limit_buckets`);
    const app = await build(PROXY);
    try {
      await hitPair(app, { remoteAddress: PROXY, xff: SPOOFED });
      expect(await bucketHits(SPOOFED)).toBeGreaterThanOrEqual(1);
      expect(await bucketHits(PROXY)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("ignores X-Forwarded-For when the immediate peer is not trusted", async () => {
    await appPool.query(`DELETE FROM app.rate_limit_buckets`);
    const app = await build(PROXY);
    try {
      await hitPair(app, { remoteAddress: PEER, xff: SPOOFED });
      expect(await bucketHits(PEER)).toBeGreaterThanOrEqual(1);
      expect(await bucketHits(SPOOFED)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("TRUST_PROXY=1 peels exactly one hop; leftmost spoof is not trusted (STH-42)", async () => {
    await appPool.query(`DELETE FROM app.rate_limit_buckets`);
    const app = await build("1");
    try {
      // Direct peer + multi-hop XFF: hop-count 1 → rightmost entry only.
      await hitPair(app, {
        remoteAddress: PEER,
        xff: `${SPOOFED}, ${INTERMEDIATE}`,
      });
      expect(await bucketHits(INTERMEDIATE)).toBeGreaterThanOrEqual(1);
      expect(await bucketHits(SPOOFED)).toBe(0);
      expect(await bucketHits(PEER)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("TRUST_PROXY=true peels the whole chain (contrast with hop count 1)", async () => {
    await appPool.query(`DELETE FROM app.rate_limit_buckets`);
    const app = await build("true");
    try {
      await hitPair(app, {
        remoteAddress: PEER,
        xff: `${SPOOFED}, ${INTERMEDIATE}`,
      });
      expect(await bucketHits(SPOOFED)).toBeGreaterThanOrEqual(1);
      expect(await bucketHits(INTERMEDIATE)).toBe(0);
    } finally {
      await app.close();
    }
  });
});
