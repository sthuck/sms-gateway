# Queue and worker (pg-boss)

Companion to Linear **STH-12**. The API publishes jobs; the `worker`
Deployment consumes them. Jobs live in the **same Postgres database** as
application data (no Redis / RabbitMQ).

## Why pg-boss (not a separate outbox)

`publishInTx(tx, event)` inserts the job with pg-boss’s `{ db }` adapter so
the job row participates in the **caller’s transaction**. If the write
rolls back, the job rolls back. If it commits, the job is durable.

That is preferable to a custom outbox + relay when the queue already uses
Postgres: one commit, no relay lag, no dual-write window. A separate
outbox table would only be needed if the broker were external.

## Schemas and privileges

| Schema | Contents | Owner / installer | Runtime role |
| --- | --- | --- | --- |
| `public` | App tables + `queue_processed_jobs` | Migrator (`sms`) via `node-pg-migrate` | `sms_app` (RLS) |
| `pgboss` | pg-boss tables (not owner-scoped) | Migrator via `scripts/bootstrap-pgboss.mjs` after `migrate:up` | `sms_app` (DML only) |

**Bootstrap (privileged):** `pnpm migrate:up` runs migrations, sets the
`sms_app` password, then `bootstrap-pgboss.mjs`, which:

1. Starts pg-boss with `createSchema` / `migrate` enabled as the migrator
2. Creates event queues and per-event dead-letter queues
3. `GRANT`s `USAGE` on schema `pgboss` and DML on its objects to `sms_app`

**Runtime (least privilege):** API and worker use
`DATABASE_URL` (`sms_app`) with `createSchema: false` and `migrate: false`.
They must **not** be given `CREATE` on the database.

pg-boss tables are **not** covered by RLS and must **never** store message
bodies or senders — only validated ID payloads (see below).

Re-run bootstrap after upgrades that change the pg-boss schema:

```bash
MIGRATE_DATABASE_URL=postgres://sms:sms@localhost:5432/sms \
  pnpm --filter @sms-gateway/backend queue:bootstrap
```

## Event schemas

Payloads are Zod-validated (`.strict()` + forbidden-key guard). **IDs only.**

### `message.created`

```json
{
  "type": "message.created",
  "owner_id": "<uuid>",
  "message_id": "<uuid>",
  "device_id": "<uuid>"
}
```

### `stream.reclassify`

```json
{
  "type": "stream.reclassify",
  "owner_id": "<uuid>",
  "stream_id": "<uuid>"
}
```

Forbidden keys (top-level or nested): `body`, `body_ciphertext`,
`ciphertext`, `sender`, `text`, `message`, `messages`, `content`,
`plaintext`.

Dead-letter queues: `message.created.dlq`, `stream.reclassify.dlq`.

## Delivery semantics

- **At-least-once.** A handler may run more than once for the same job
  (crash after side effect, visibility timeout, retry).
- Handlers must be **idempotent**. Preferred pattern:

  1. Inside `withOwner(owner_id, …)`, call `claimProcessed(client, { dedupeKey })`
  2. If `claimed === false`, return success (already applied)
  3. Else perform the side effect in the **same** transaction

  Table: `queue_processed_jobs` (RLS owner-scoped). Helpers:
  `messageCreatedDedupeKey`, `streamReclassifyDedupeKey`.

- Optional enqueue-time dedupe: pass `singletonKey` to `publishInTx`.

## Publishing

```ts
await withOwner(pool, ownerId, async (client) => {
  // … insert message …
  await publishInTx(boss, client, {
    type: "message.created",
    owner_id: ownerId,
    message_id: messageId,
    device_id: deviceId,
  });
});
```

## Worker

- Entrypoint: `node dist/worker.js` / `pnpm worker`
- Each job: validate payload → `withOwner(owner_id, handler)` so RLS applies
- Stub handlers for `message.created` / `stream.reclassify` log IDs only
  (stream engine is later tickets)
- **SIGTERM / SIGINT:** `boss.stop({ graceful: true })` stops fetching and
  waits for in-flight jobs up to `QUEUE_SHUTDOWN_TIMEOUT_MS`
- Metrics: counters
  `sms_gateway_queue_jobs_{completed,failed,dead_lettered}_total` on
  `GET http://$QUEUE_METRICS_HOST:$QUEUE_METRICS_PORT/metrics` (default
  `:9090`). Set `QUEUE_METRICS_PORT=0` to disable.

## Retry / DLQ policy

| Setting | Env | Default |
| --- | --- | --- |
| Retry limit | `QUEUE_RETRY_LIMIT` | `5` |
| Base delay (seconds) | `QUEUE_RETRY_DELAY_SECONDS` | `1` |
| Exponential backoff | `QUEUE_RETRY_BACKOFF` | `true` |
| Max delay (seconds) | `QUEUE_RETRY_DELAY_MAX_SECONDS` | `300` |

After retries are exhausted, pg-boss copies the job into the queue’s
`deadLetter` queue. The worker’s DLQ observers log at `error` and increment
the dead-lettered counter (visible in logs/metrics). Redrive is operational
(pg-boss `redrive()`), not automated.

## Scaling

Multiple worker replicas are safe: pg-boss fetch uses `SKIP LOCKED`. Pair
with Helm `worker.replicaCount` and `QUEUE_LOCAL_CONCURRENCY`. Side effects
remain single-effect via `claimProcessed` / `singletonKey`.

## How to add an event

1. Add a Zod schema in `backend/src/queue/events.ts` and extend
   `EVENT_NAMES` / `QueueEventSchema`.
2. Add the name to `EVENT_NAMES` in `scripts/bootstrap-pgboss.mjs` (or rely
   on `ensureQueues` which reads `EVENT_NAMES`).
3. Document the payload here (IDs only).
4. Add a stub (or real) handler and register it in `worker.ts`.
5. Publish with `publishInTx` in the same transaction as the data write.
6. Add tests: payload rejects bodies; handler idempotency if it has effects.

## Code map

| Path | Role |
| --- | --- |
| `src/queue/publish.ts` | `publishInTx` |
| `src/queue/register.ts` | `registerOwnerHandler`, DLQ observer |
| `src/queue/idempotency.ts` | `claimProcessed` |
| `src/queue/events.ts` | Schemas + forbidden-key guard |
| `src/queue/boss.ts` | PgBoss factory (install vs runtime) |
| `scripts/bootstrap-pgboss.mjs` | Privileged schema install + grants |
