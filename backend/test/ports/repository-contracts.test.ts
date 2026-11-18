import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { InfrastructureError } from "../../src/domain/errors.js";
import {
  PgIdentityRepository,
  PgSessionRepository,
  PgUserRepository,
} from "../../src/adapters/db-postgres/index.js";
import {
  MemoryIdentityRepository,
  MemorySessionRepository,
  MemoryUserRepository,
} from "../application/fakes/memory-ports.js";
import {
  canConnect,
  createAdminPool,
  createAppPool,
  migrateDatabaseUrl,
  resetSchema,
  runMigrations,
} from "../helpers/pg.js";

const migratorOk = await canConnect(migrateDatabaseUrl());

const OWNER = "00000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);

describe("outbound port contracts (null = not found; infra throws InfrastructureError)", () => {
  describe("in-memory fakes — every method", () => {
    it("SessionRepository: each method throws InfrastructureError when fault is set", async () => {
      const sessions = new MemorySessionRepository();
      await expect(sessions.lookupBySessionIdHash("missing")).resolves.toBeNull();

      sessions.fault.throwInfra = true;
      await expect(
        sessions.insert({
          ownerId: OWNER,
          sessionIdHash: HASH,
          csrfTokenHash: HASH,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toBeInstanceOf(InfrastructureError);
      await expect(sessions.lookupBySessionIdHash(HASH)).rejects.toBeInstanceOf(
        InfrastructureError,
      );
      await expect(sessions.revokeBySessionIdHash(OWNER, HASH)).rejects.toBeInstanceOf(
        InfrastructureError,
      );
      await expect(sessions.touch(OWNER, "row-1")).rejects.toBeInstanceOf(InfrastructureError);
    });

    it("IdentityRepository: each method throws InfrastructureError when fault is set", async () => {
      const identities = new MemoryIdentityRepository();
      await expect(identities.findByIssuerSub("iss", "sub")).resolves.toBeNull();

      identities.fault.throwInfra = true;
      await expect(identities.findByIssuerSub("iss", "sub")).rejects.toBeInstanceOf(
        InfrastructureError,
      );
      await expect(identities.link(OWNER, "iss", "sub")).rejects.toBeInstanceOf(
        InfrastructureError,
      );
    });

    it("UserRepository: each method throws InfrastructureError when fault is set", async () => {
      const users = new MemoryUserRepository();
      await expect(users.findById(OWNER, OWNER)).resolves.toBeNull();

      users.fault.throwInfra = true;
      await expect(users.findById(OWNER, OWNER)).rejects.toBeInstanceOf(InfrastructureError);
      await expect(users.findByEmail("a@b.c")).rejects.toBeInstanceOf(InfrastructureError);
      await expect(
        users.create({
          ownerId: OWNER,
          email: "a@b.c",
          mfaEnrolled: false,
          lastAuthMethod: null,
          displayName: null,
        }),
      ).rejects.toBeInstanceOf(InfrastructureError);
      await expect(
        users.updateAuthProfile({
          ownerId: OWNER,
          mfaEnrolled: true,
          lastAuthMethod: "otp",
          displayName: "A",
        }),
      ).rejects.toBeInstanceOf(InfrastructureError);
      await expect(
        users.linkIdentityAndUpdate({
          ownerId: OWNER,
          issuer: "iss",
          sub: "sub",
          mfaEnrolled: true,
          lastAuthMethod: "otp",
          displayName: "A",
        }),
      ).rejects.toBeInstanceOf(InfrastructureError);
    });
  });

  describe.skipIf(!migratorOk)("Postgres adapters — every method + exploding pool", () => {
    let admin: Pool;
    let appPool: Pool;
    let exploding: Pool;

    beforeAll(async () => {
      admin = createAdminPool();
      await resetSchema(admin);
      await runMigrations("up");
      // Seed owner so withOwner RLS paths can run against a live pool for null-miss cases.
      await admin.query(
        `INSERT INTO users (id, owner_id, email) VALUES ($1, $1, 'contract@example.com')
         ON CONFLICT DO NOTHING`,
        [OWNER],
      );
      appPool = createAppPool();
      exploding = {
        query: async () => {
          throw new Error("simulated postgres outage");
        },
        connect: async () => {
          throw new Error("simulated postgres outage");
        },
        end: async () => undefined,
      } as unknown as Pool;
    }, 120_000);

    afterAll(async () => {
      await appPool?.end().catch(() => undefined);
      await admin?.end().catch(() => undefined);
    });

    it("PgSessionRepository: null on miss; every method → InfrastructureError on fault", async () => {
      const ok = new PgSessionRepository(appPool);
      await expect(ok.lookupBySessionIdHash(HASH)).resolves.toBeNull();

      const broken = new PgSessionRepository(exploding);
      const cases: Array<[string, () => Promise<unknown>]> = [
        [
          "insert",
          () =>
            broken.insert({
              ownerId: OWNER,
              sessionIdHash: HASH,
              csrfTokenHash: HASH,
              expiresAt: new Date(Date.now() + 60_000),
            }),
        ],
        ["lookupBySessionIdHash", () => broken.lookupBySessionIdHash(HASH)],
        ["revokeBySessionIdHash", () => broken.revokeBySessionIdHash(OWNER, HASH)],
        ["touch", () => broken.touch(OWNER, OWNER)],
      ];
      for (const [name, fn] of cases) {
        await expect(fn(), name).rejects.toBeInstanceOf(InfrastructureError);
      }
    });

    it("PgIdentityRepository: null on miss; every method → InfrastructureError on fault", async () => {
      const ok = new PgIdentityRepository(appPool);
      await expect(ok.findByIssuerSub("https://idp", "nobody")).resolves.toBeNull();

      const broken = new PgIdentityRepository(exploding);
      await expect(broken.findByIssuerSub("iss", "sub")).rejects.toBeInstanceOf(
        InfrastructureError,
      );
      await expect(broken.link(OWNER, "iss", "sub")).rejects.toBeInstanceOf(InfrastructureError);
    });

    it("PgUserRepository: null on miss; every method → InfrastructureError on fault", async () => {
      const ok = new PgUserRepository(appPool);
      await expect(ok.findByEmail("nobody@example.com")).resolves.toBeNull();

      const broken = new PgUserRepository(exploding);
      const cases: Array<[string, () => Promise<unknown>]> = [
        ["findById", () => broken.findById(OWNER, OWNER)],
        ["findByEmail", () => broken.findByEmail("x@y.z")],
        [
          "create",
          () =>
            broken.create({
              ownerId: OWNER,
              email: "x@y.z",
              mfaEnrolled: false,
              lastAuthMethod: null,
              displayName: null,
            }),
        ],
        [
          "updateAuthProfile",
          () =>
            broken.updateAuthProfile({
              ownerId: OWNER,
              mfaEnrolled: true,
              lastAuthMethod: "otp",
              displayName: "A",
            }),
        ],
        [
          "linkIdentityAndUpdate",
          () =>
            broken.linkIdentityAndUpdate({
              ownerId: OWNER,
              issuer: "iss",
              sub: "sub",
              mfaEnrolled: true,
              lastAuthMethod: "otp",
              displayName: "A",
            }),
        ],
      ];
      for (const [name, fn] of cases) {
        await expect(fn(), name).rejects.toBeInstanceOf(InfrastructureError);
      }
    });
  });
});
