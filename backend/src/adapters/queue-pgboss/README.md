# queue-pgboss adapter

Postgres-backed queue (pg-boss): publisher (`publishInTx`), worker
registration (`registerOwnerHandler`), idempotency helpers, and metrics.

Implements the `QueuePublisher` port via `PgBossQueuePublisher`.
