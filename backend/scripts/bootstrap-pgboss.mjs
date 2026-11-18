#!/usr/bin/env node
/**
 * Install / upgrade the pg-boss schema as the migrator role, ensure event
 * queues + DLQs exist, then grant least-privilege DML to sms_app.
 *
 * Runtime API/worker connect as sms_app with createSchema/migrate disabled.
 */
import pg from "pg";
import { PgBoss } from "pg-boss";

const EVENT_NAMES = ["message.created", "stream.reclassify"];

const databaseUrl = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Set MIGRATE_DATABASE_URL (preferred) or DATABASE_URL for pg-boss bootstrap.");
  process.exit(1);
}

const schema = process.env.QUEUE_SCHEMA ?? "pgboss";
const retryLimit = Number(process.env.QUEUE_RETRY_LIMIT ?? "5");
const retryDelay = Number(process.env.QUEUE_RETRY_DELAY_SECONDS ?? "1");
const retryBackoff = !["0", "false", "FALSE"].includes(process.env.QUEUE_RETRY_BACKOFF ?? "true");
const retryDelayMax = Number(process.env.QUEUE_RETRY_DELAY_MAX_SECONDS ?? "300");

async function main() {
  const boss = new PgBoss({
    connectionString: databaseUrl,
    schema,
    createSchema: true,
    migrate: true,
    application_name: "sms-gateway-queue-bootstrap",
    schedule: false,
    supervise: false,
  });

  await boss.start();

  for (const name of EVENT_NAMES) {
    const dlq = `${name}.dlq`;
    await boss.createQueue(dlq, {
      retryLimit: 0,
      deleteAfterSeconds: 60 * 60 * 24 * 30,
    });
    await boss.createQueue(name, {
      policy: "standard",
      retryLimit,
      retryDelay,
      retryBackoff,
      retryDelayMax,
      deadLetter: dlq,
    });
  }

  await boss.stop({ graceful: false, timeout: 5_000 });

  await grantAppRole(databaseUrl, schema);
  console.log(`pg-boss schema "${schema}" ready; grants applied for sms_app`);
}

async function grantAppRole(url, schemaName) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`GRANT USAGE ON SCHEMA ${quoteIdent(schemaName)} TO sms_app`);
    await client.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE
        ON ALL TABLES IN SCHEMA ${quoteIdent(schemaName)} TO sms_app
    `);
    await client.query(`
      GRANT USAGE, SELECT
        ON ALL SEQUENCES IN SCHEMA ${quoteIdent(schemaName)} TO sms_app
    `);
    await client.query(`
      GRANT EXECUTE
        ON ALL FUNCTIONS IN SCHEMA ${quoteIdent(schemaName)} TO sms_app
    `);
    // Future objects created by the migrator during upgrades.
    await client.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(schemaName)}
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sms_app
    `);
    await client.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(schemaName)}
        GRANT USAGE, SELECT ON SEQUENCES TO sms_app
    `);
    await client.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(schemaName)}
        GRANT EXECUTE ON FUNCTIONS TO sms_app
    `);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

function quoteIdent(ident) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(ident)) {
    throw new Error(`Invalid schema identifier: ${ident}`);
  }
  return `"${ident.replace(/"/g, '""')}"`;
}

void main().catch((err) => {
  console.error("pg-boss bootstrap failed:", err);
  process.exit(1);
});
