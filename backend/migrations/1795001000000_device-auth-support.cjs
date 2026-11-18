/**
 * STH-14: shared replay cache and rate-limit buckets for device auth.
 *
 * These live in the `app` schema (not owner-scoped RLS tables). Identity for
 * replay is either a device UUID or SHA-256(SPKI) at pairing — known before
 * `app.owner_id` is set. Both tables are cleaned by `expires_at` /
 * window expiry; the app deletes stale rows opportunistically.
 *
 * @type {import("node-pg-migrate").MigrationBuilder}
 */
exports.shorthands = undefined;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS app.device_replay_cache (
      identity text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('nonce', 'signature')),
      value_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (identity, kind, value_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_device_replay_expires
      ON app.device_replay_cache (expires_at);

    CREATE TABLE IF NOT EXISTS app.rate_limit_buckets (
      bucket_key text PRIMARY KEY,
      window_start timestamptz NOT NULL,
      hit_count integer NOT NULL DEFAULT 0,
      locked_until timestamptz
    );

    REVOKE ALL ON TABLE app.device_replay_cache FROM PUBLIC;
    REVOKE ALL ON TABLE app.rate_limit_buckets FROM PUBLIC;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.device_replay_cache TO sms_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.rate_limit_buckets TO sms_app;
  `);
};

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS app.rate_limit_buckets;
    DROP TABLE IF EXISTS app.device_replay_cache;
  `);
};
