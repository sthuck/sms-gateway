/**
 * STH-9: web UI sessions + auth lookup helpers.
 * Session ids are stored hashed; plaintext never hits the database.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = async (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS last_auth_method TEXT,
      ADD COLUMN IF NOT EXISTS display_name TEXT;
  `);

  pgm.sql(`
    CREATE TABLE sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      -- SHA-256 hex of the opaque session id presented in the cookie
      session_id_hash TEXT NOT NULL,
      csrf_token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT sessions_hash_unique UNIQUE (session_id_hash)
    );

    CREATE INDEX idx_sessions_owner ON sessions (owner_id);
    CREATE INDEX idx_sessions_expires ON sessions (expires_at)
      WHERE revoked_at IS NULL;

    GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO sms_app;
  `);

  pgm.sql(`
    ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
    CREATE POLICY owner_isolation ON sessions
      FOR ALL
      TO sms_app
      USING (owner_id = app.current_owner_id())
      WITH CHECK (owner_id = app.current_owner_id());
  `);

  // Resolve (issuer, sub) → user before app.owner_id is known (first request / login).
  pgm.sql(`
    CREATE OR REPLACE FUNCTION app.lookup_user_identity(p_issuer text, p_sub text)
    RETURNS TABLE (
      identity_id uuid,
      owner_id uuid,
      email text,
      mfa_enrolled boolean,
      display_name text
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, app
    AS $fn$
    BEGIN
      RETURN QUERY
      SELECT
        ui.id,
        ui.owner_id,
        u.email,
        u.mfa_enrolled,
        u.display_name
      FROM user_identities ui
      JOIN users u ON u.id = ui.owner_id
      WHERE ui.issuer = p_issuer
        AND ui.sub = p_sub;
    END;
    $fn$;

    REVOKE ALL ON FUNCTION app.lookup_user_identity(text, text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.lookup_user_identity(text, text) TO sms_app;
  `);

  // Session cookie lookup before owner is known.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION app.lookup_session(p_session_id_hash text)
    RETURNS TABLE (
      session_row_id uuid,
      owner_id uuid,
      csrf_token_hash text,
      expires_at timestamptz,
      revoked_at timestamptz
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, app
    AS $fn$
    BEGIN
      RETURN QUERY
      SELECT
        s.id,
        s.owner_id,
        s.csrf_token_hash,
        s.expires_at,
        s.revoked_at
      FROM sessions s
      WHERE s.session_id_hash = p_session_id_hash;
    END;
    $fn$;

    REVOKE ALL ON FUNCTION app.lookup_session(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.lookup_session(text) TO sms_app;
  `);

  // Optional email auto-link (default off in app config). Narrow projection only.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION app.lookup_user_by_email(p_email text)
    RETURNS TABLE (
      owner_id uuid,
      email text,
      mfa_enrolled boolean
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, app
    AS $fn$
    BEGIN
      RETURN QUERY
      SELECT u.id, u.email, u.mfa_enrolled
      FROM users u
      WHERE lower(u.email) = lower(p_email)
      LIMIT 1;
    END;
    $fn$;

    REVOKE ALL ON FUNCTION app.lookup_user_by_email(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.lookup_user_by_email(text) TO sms_app;
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = async (pgm) => {
  pgm.sql(`DROP FUNCTION IF EXISTS app.lookup_user_by_email(text)`);
  pgm.sql(`DROP FUNCTION IF EXISTS app.lookup_session(text)`);
  pgm.sql(`DROP FUNCTION IF EXISTS app.lookup_user_identity(text, text)`);

  pgm.sql(`DROP POLICY IF EXISTS owner_isolation ON sessions`);
  pgm.sql(`DROP TABLE IF EXISTS sessions CASCADE`);

  pgm.sql(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS last_auth_method,
      DROP COLUMN IF EXISTS display_name;
  `);
};
