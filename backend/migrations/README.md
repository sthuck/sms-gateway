# Database migrations

Tooling: [node-pg-migrate](https://github.com/salsita/node-pg-migrate).

```bash
pnpm migrate:create -- <name>
pnpm migrate:up
pnpm migrate:down
```

No schema migrations yet. Postgres schema, RLS, and real migrations are
Linear **STH-8**.
