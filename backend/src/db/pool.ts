import pg, { type Pool, type PoolConfig } from "pg";

const { Pool: PgPool } = pg;

export type CreatePoolOptions = PoolConfig;

/**
 * Create a pg Pool for the application role (sms_app).
 * Callers must not share PoolClient instances across requests.
 */
export function createPool(options: CreatePoolOptions): Pool {
  if (!options.connectionString && !options.host && !options.user) {
    throw new Error("createPool requires connectionString or host/user config");
  }
  return new PgPool({
    idleTimeoutMillis: 10_000,
    max: 10,
    ...options,
  });
}
