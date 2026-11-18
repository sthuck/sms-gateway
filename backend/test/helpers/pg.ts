import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type Pool } from "pg";
import { createPool } from "../../src/db/pool.js";

const { Pool: PgPool } = pg;
const execFileAsync = promisify(execFile);

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function migrateDatabaseUrl(): string {
  const url =
    process.env.MIGRATE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://sms:sms@127.0.0.1:5432/sms";
  return url;
}

export function appDatabaseUrl(): string {
  const url =
    process.env.APP_DATABASE_URL ??
    process.env.DATABASE_URL_APP ??
    "postgres://sms_app:sms_app@127.0.0.1:5432/sms";
  return url;
}

export function createAdminPool(): Pool {
  return createPool({ connectionString: migrateDatabaseUrl() });
}

export function createAppPool(): Pool {
  return createPool({ connectionString: appDatabaseUrl() });
}

/**
 * Local-dev-only password for tests / Compose / CI.
 * migrate.mjs has no hardcoded default — callers must set SMS_APP_PASSWORD.
 */
export const LOCAL_DEV_SMS_APP_PASSWORD = "sms_app";

export async function runMigrations(direction: "up" | "down" = "up"): Promise<void> {
  const env = {
    ...process.env,
    DATABASE_URL: migrateDatabaseUrl(),
    MIGRATE_DATABASE_URL: migrateDatabaseUrl(),
    // Explicit local-dev value for tests; never rely on a migrate.mjs fallback.
    SMS_APP_PASSWORD: process.env.SMS_APP_PASSWORD ?? LOCAL_DEV_SMS_APP_PASSWORD,
  };
  await execFileAsync("node", ["scripts/migrate.mjs", direction], {
    cwd: backendRoot,
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
}

export async function resetSchema(admin: Pool): Promise<void> {
  await admin.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO PUBLIC;
    DROP SCHEMA IF EXISTS app CASCADE;
  `);
}

/** Owned tables discovered from the catalog (must have owner_id). */
export async function listOwnedTables(admin: Pool): Promise<string[]> {
  const { rows } = await admin.query<{ table_name: string }>(`
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'owner_id'
    ORDER BY c.table_name
  `);
  return rows.map((r) => r.table_name);
}

export type SeededOwners = {
  ownerA: string;
  ownerB: string;
  deviceA: string;
  deviceB: string;
  messageA: string;
  messageB: string;
  streamA: string;
  streamB: string;
  agentA: string;
  agentB: string;
};

/**
 * Insert one row per owned table for owners A and B.
 * Uses the migrator connection (superuser / BYPASSRLS) so seeding is not
 * subject to RLS. Never logs message bodies.
 */
export async function seedTwoOwners(admin: Pool): Promise<SeededOwners> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");

    const userA = (
      await client.query<{ id: string }>(
        `INSERT INTO users (email, mfa_enrolled)
         VALUES ('owner-a@example.com', true)
         RETURNING id`,
      )
    ).rows[0]!.id;
    // Trigger sets owner_id = id; ensure explicitly for clarity.
    await client.query(`UPDATE users SET owner_id = id WHERE id = $1`, [userA]);

    const userB = (
      await client.query<{ id: string }>(
        `INSERT INTO users (email, mfa_enrolled)
         VALUES ('owner-b@example.com', true)
         RETURNING id`,
      )
    ).rows[0]!.id;
    await client.query(`UPDATE users SET owner_id = id WHERE id = $1`, [userB]);

    await client.query(
      `INSERT INTO user_identities (owner_id, issuer, sub)
       VALUES ($1, 'https://idp.example/a', 'sub-a'),
              ($2, 'https://idp.example/b', 'sub-b')`,
      [userA, userB],
    );

    const deviceA = (
      await client.query<{ id: string }>(
        `INSERT INTO devices (owner_id, name, platform_info, status)
         VALUES ($1, 'Pixel A', '{"manufacturer":"Google"}'::jsonb, 'active')
         RETURNING id`,
        [userA],
      )
    ).rows[0]!.id;
    const deviceB = (
      await client.query<{ id: string }>(
        `INSERT INTO devices (owner_id, name, platform_info, status)
         VALUES ($1, 'Pixel B', '{"manufacturer":"Google"}'::jsonb, 'active')
         RETURNING id`,
        [userB],
      )
    ).rows[0]!.id;

    await client.query(
      `INSERT INTO device_credentials (owner_id, device_id, public_key)
       VALUES
         ($1, $2, 'pk-a'),
         ($3, $4, 'pk-b')`,
      [userA, deviceA, userB, deviceB],
    );

    await client.query(
      `INSERT INTO pairing_codes (owner_id, code_hash, expires_at)
       VALUES
         ($1, 'hash-a', now() + interval '5 minutes'),
         ($2, 'hash-b', now() + interval '5 minutes')`,
      [userA, userB],
    );

    const messageA = (
      await client.query<{ id: string }>(
        `INSERT INTO messages (
           owner_id, device_id, device_msg_id, sender, body_ciphertext,
           received_at, sim_slot, direction
         ) VALUES (
           $1, $2, 'sms-a1', '+10000000001', decode('aa', 'hex'),
           now(), 0, 'inbound'
         ) RETURNING id`,
        [userA, deviceA],
      )
    ).rows[0]!.id;
    const messageB = (
      await client.query<{ id: string }>(
        `INSERT INTO messages (
           owner_id, device_id, device_msg_id, sender, body_ciphertext,
           received_at, sim_slot, direction
         ) VALUES (
           $1, $2, 'sms-b1', '+10000000002', decode('bb', 'hex'),
           now(), 0, 'inbound'
         ) RETURNING id`,
        [userB, deviceB],
      )
    ).rows[0]!.id;

    const streamA = (
      await client.query<{ id: string }>(
        `INSERT INTO streams (owner_id, name, mode, rules_json, ai_prompt, version)
         VALUES ($1, 'Banks A', 'rules', '[]'::jsonb, NULL, 1)
         RETURNING id`,
        [userA],
      )
    ).rows[0]!.id;
    const streamB = (
      await client.query<{ id: string }>(
        `INSERT INTO streams (owner_id, name, mode, rules_json, ai_prompt, version)
         VALUES ($1, 'Banks B', 'ai', '[]'::jsonb, 'bank alerts', 1)
         RETURNING id`,
        [userB],
      )
    ).rows[0]!.id;

    await client.query(
      `INSERT INTO stream_membership (
         stream_id, message_id, owner_id, matched_by, confidence, stream_version
       ) VALUES
         ($1, $2, $3, 'rule', 1.0, 1),
         ($4, $5, $6, 'ai', 0.9, 1)`,
      [streamA, messageA, userA, streamB, messageB, userB],
    );

    const agentA = (
      await client.query<{ id: string }>(
        `INSERT INTO agent_clients (
           owner_id, name, kind, key_hash, key_prefix
         ) VALUES ($1, 'agent-a', 'api_key', 'hash-a', 'sgw_a')
         RETURNING id`,
        [userA],
      )
    ).rows[0]!.id;
    const agentB = (
      await client.query<{ id: string }>(
        `INSERT INTO agent_clients (
           owner_id, name, kind, client_id, redirect_uris
         ) VALUES ($1, 'agent-b', 'oauth', 'client-b', ARRAY['https://b.example/cb'])
         RETURNING id`,
        [userB],
      )
    ).rows[0]!.id;

    await client.query(
      `INSERT INTO agent_grants (owner_id, agent_client_id, stream_id, scopes)
       VALUES
         ($1, $2, $3, ARRAY['stream:read']),
         ($4, $5, $6, ARRAY['stream:read'])`,
      [userA, agentA, streamA, userB, agentB, streamB],
    );

    await client.query(
      `INSERT INTO audit_log (owner_id, actor_type, actor_id, action, stream_id, message_count)
       VALUES
         ($1, 'user', $1, 'stream.read', $2, 1),
         ($3, 'user', $3, 'stream.read', $4, 1)`,
      [userA, streamA, userB, streamB],
    );

    await client.query(
      `INSERT INTO sender_ai_optout (owner_id, sender_pattern)
       VALUES ($1, 'BankA*'), ($2, 'BankB*')`,
      [userA, userB],
    );

    await client.query("COMMIT");

    return {
      ownerA: userA,
      ownerB: userB,
      deviceA,
      deviceB,
      messageA,
      messageB,
      streamA,
      streamB,
      agentA,
      agentB,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function canConnect(url: string): Promise<boolean> {
  const pool = new PgPool({ connectionString: url, connectionTimeoutMillis: 2000, max: 1 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}
