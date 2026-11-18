import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import {
  appDatabaseUrl,
  canConnect,
  createAdminPool,
  LOCAL_DEV_SMS_APP_PASSWORD,
  migrateDatabaseUrl,
  resetSchema,
  runMigrations,
} from "../helpers/pg.js";

const execFileAsync = promisify(execFile);
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function appUrlWithPassword(password: string): string {
  const url = new URL(appDatabaseUrl());
  url.password = password;
  return url.href;
}

const migratorOk = await canConnect(migrateDatabaseUrl());
if (!migratorOk && process.env.CI === "true") {
  throw new Error(`Postgres migrator unreachable at ${migrateDatabaseUrl()}`);
}

describe.skipIf(!migratorOk)("migrate.mjs SMS_APP_PASSWORD policy", () => {
  let admin: Pool;

  beforeAll(() => {
    admin = createAdminPool();
  });

  afterAll(async () => {
    await admin?.end().catch(() => undefined);
  });

  it("fails fast when SMS_APP_PASSWORD is unset on migrate:up", async () => {
    const env = { ...process.env };
    delete env.SMS_APP_PASSWORD;
    env.MIGRATE_DATABASE_URL = migrateDatabaseUrl();
    env.DATABASE_URL = migrateDatabaseUrl();

    await expect(
      execFileAsync("node", ["scripts/migrate.mjs", "up"], {
        cwd: backendRoot,
        env,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/SMS_APP_PASSWORD is required/i),
    });
  });

  it("does not reset an existing sms_app password on later migrate:up", async () => {
    await resetSchema(admin);
    // Ensure role + schema exist (password applied only if the role was missing).
    await runMigrations("up");

    const rotated = "rotated-test-password-not-default";
    await setRolePassword(admin, rotated);
    const beforeHash = await rolePasswordHash(admin);
    expect(beforeHash).toBeTruthy();

    // Later up must succeed with SMS_APP_PASSWORD set, but must not overwrite.
    await runMigrations("up");

    const afterHash = await rolePasswordHash(admin);
    expect(afterHash).toBe(beforeHash);

    // When the server enforces passwords (not local trust), rotated works and default does not.
    if (await passwordAuthEnforced()) {
      await expect(canConnect(appUrlWithPassword(rotated))).resolves.toBe(true);
      await expect(canConnect(appUrlWithPassword(LOCAL_DEV_SMS_APP_PASSWORD))).resolves.toBe(false);
    }

    // Restore local-dev password so subsequent test files can connect via APP_DATABASE_URL.
    await setRolePassword(admin, LOCAL_DEV_SMS_APP_PASSWORD);
  }, 120_000);
});

async function rolePasswordHash(admin: Pool): Promise<string | null> {
  const { rows } = await admin.query<{ rolpassword: string | null }>(
    `SELECT rolpassword FROM pg_authid WHERE rolname = 'sms_app'`,
  );
  return rows[0]?.rolpassword ?? null;
}

/** False under pg_hba trust/peer where any password is accepted. */
async function passwordAuthEnforced(): Promise<boolean> {
  const probe = "definitely-wrong-password-xyz";
  const okWrong = await canConnect(appUrlWithPassword(probe));
  return !okWrong;
}

async function setRolePassword(admin: Pool, password: string): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('sms.test_app_password', $1, true)", [password]);
    await client.query(`
      DO $pwd$
      BEGIN
        EXECUTE format(
          'ALTER ROLE sms_app PASSWORD %L',
          current_setting('sms.test_app_password', true)
        );
      END
      $pwd$;
    `);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
