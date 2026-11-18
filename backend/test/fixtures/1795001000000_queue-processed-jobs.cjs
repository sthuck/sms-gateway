/**
 * Fixture copy of PR #5 (STH-12) migration — used only to prove ID ordering
 * coexistence with 1795002000000_device-auth-support (STH-40).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE queue_processed_jobs (
      owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      dedupe_key TEXT NOT NULL,
      job_name TEXT NOT NULL,
      job_id UUID,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_id, dedupe_key)
    );

    CREATE INDEX queue_processed_jobs_owner_processed_at_idx
      ON queue_processed_jobs (owner_id, processed_at DESC);

    ALTER TABLE queue_processed_jobs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE queue_processed_jobs FORCE ROW LEVEL SECURITY;

    CREATE POLICY owner_isolation ON queue_processed_jobs
      FOR ALL
      TO sms_app
      USING (owner_id = app.current_owner_id())
      WITH CHECK (owner_id = app.current_owner_id());

    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE queue_processed_jobs TO sms_app;
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = async (pgm) => {
  pgm.sql(`
    DROP POLICY IF EXISTS owner_isolation ON queue_processed_jobs;
    DROP TABLE IF EXISTS queue_processed_jobs;
  `);
};
