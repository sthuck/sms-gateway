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
  appDatabaseUrl,
  canConnect,
  createAdminPool,
  createAppPool,
  migrateDatabaseUrl,
  resetSchema,
  runMigrations,
} from "../helpers/pg.js";

const migratorOk = await canConnect(migrateDatabaseUrl());

type SessionSut = {
  name: string;
  sessions: MemorySessionRepository | PgSessionRepository;
  injectFault: () => void;
  clearFault?: () => void;
};

type IdentitySut = {
  name: string;
  identities: MemoryIdentityRepository | PgIdentityRepository;
  injectFault: () => void;
};

describe("outbound port contracts (null = not found; infra throws InfrastructureError)", () => {
  describe("SessionRepository (in-memory)", () => {
    it("returns null for missing hash and InfrastructureError on fault", async () => {
      const sessions = new MemorySessionRepository();
      await expect(sessions.lookupBySessionIdHash("missing")).resolves.toBeNull();
      sessions.fault.throwInfra = true;
      await expect(sessions.lookupBySessionIdHash("x")).rejects.toBeInstanceOf(InfrastructureError);
    });
  });

  describe("IdentityRepository (in-memory)", () => {
    it("returns null for unknown issuer/sub and InfrastructureError on fault", async () => {
      const identities = new MemoryIdentityRepository();
      await expect(identities.findByIssuerSub("iss", "sub")).resolves.toBeNull();
      identities.fault.throwInfra = true;
      await expect(identities.findByIssuerSub("iss", "sub")).rejects.toBeInstanceOf(
        InfrastructureError,
      );
    });
  });

  describe("UserRepository (in-memory)", () => {
    it("returns null for missing user and InfrastructureError on fault", async () => {
      const users = new MemoryUserRepository();
      await expect(users.findById("o", "missing")).resolves.toBeNull();
      users.fault.throwInfra = true;
      await expect(users.findById("o", "x")).rejects.toBeInstanceOf(InfrastructureError);
    });
  });

  describe.skipIf(!migratorOk)("Postgres adapters + fault injection", () => {
    let admin: Pool;
    let appPool: Pool;
    let exploding: Pool;

    beforeAll(async () => {
      admin = createAdminPool();
      await resetSchema(admin);
      await runMigrations("up");
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
      void appDatabaseUrl;
    }, 120_000);

    afterAll(async () => {
      await appPool?.end().catch(() => undefined);
      await admin?.end().catch(() => undefined);
    });

    it("PgSessionRepository: null on miss; InfrastructureError when pool throws", async () => {
      const ok = new PgSessionRepository(appPool);
      await expect(ok.lookupBySessionIdHash("deadbeef".repeat(8))).resolves.toBeNull();

      const broken = new PgSessionRepository(exploding);
      await expect(broken.lookupBySessionIdHash("x")).rejects.toBeInstanceOf(InfrastructureError);
    });

    it("PgIdentityRepository: null on miss; InfrastructureError when pool throws", async () => {
      const ok = new PgIdentityRepository(appPool);
      await expect(ok.findByIssuerSub("https://idp", "nobody")).resolves.toBeNull();

      const broken = new PgIdentityRepository(exploding);
      await expect(broken.findByIssuerSub("iss", "sub")).rejects.toBeInstanceOf(
        InfrastructureError,
      );
    });

    it("PgUserRepository: null on miss; InfrastructureError when pool throws", async () => {
      const ok = new PgUserRepository(appPool);
      await expect(ok.findByEmail("nobody@example.com")).resolves.toBeNull();

      const broken = new PgUserRepository(exploding);
      await expect(broken.findByEmail("x@y.z")).rejects.toBeInstanceOf(InfrastructureError);
    });
  });
});

// silence unused type helpers in tsc if tree-shaken oddly
void (null as unknown as SessionSut | IdentitySut);
