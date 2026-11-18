/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/** Tables that carry owner_id and must have FORCE ROW LEVEL SECURITY. */
const OWNED_TABLES = [
  "users",
  "user_identities",
  "devices",
  "device_credentials",
  "pairing_codes",
  "messages",
  "streams",
  "stream_membership",
  "agent_clients",
  "agent_grants",
  "audit_log",
  "sender_ai_optout",
];

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = async (pgm) => {
  // Safe owner lookup: missing/empty/invalid setting → NULL (zero rows), never error.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION app.current_owner_id()
    RETURNS uuid
    LANGUAGE plpgsql
    STABLE
    PARALLEL SAFE
    AS $fn$
    DECLARE
      raw text;
    BEGIN
      raw := current_setting('app.owner_id', true);
      IF raw IS NULL OR raw = '' THEN
        RETURN NULL;
      END IF;
      RETURN raw::uuid;
    EXCEPTION
      WHEN invalid_text_representation THEN
        RETURN NULL;
    END;
    $fn$;

    REVOKE ALL ON FUNCTION app.current_owner_id() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.current_owner_id() TO sms_app;
  `);

  for (const table of OWNED_TABLES) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    pgm.sql(`
      CREATE POLICY owner_isolation ON ${table}
        FOR ALL
        TO sms_app
        USING (owner_id = app.current_owner_id())
        WITH CHECK (owner_id = app.current_owner_id());
    `);
  }

  // Device auth (STH-14): resolve device + credential before owner is known.
  // Narrow projection only; never returns message bodies.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION app.lookup_device_for_auth(p_device_id uuid)
    RETURNS TABLE (
      device_id uuid,
      owner_id uuid,
      status device_status,
      public_key text,
      credential_revoked_at timestamptz
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, app
    AS $fn$
    BEGIN
      RETURN QUERY
      SELECT
        d.id,
        d.owner_id,
        d.status,
        dc.public_key,
        dc.revoked_at
      FROM devices d
      JOIN device_credentials dc ON dc.device_id = d.id
      WHERE d.id = p_device_id;
    END;
    $fn$;

    REVOKE ALL ON FUNCTION app.lookup_device_for_auth(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.lookup_device_for_auth(uuid) TO sms_app;
  `);

  // Pairing (STH-14): look up a code by hash before the session has owner_id.
  // Returns only non-expired, unused codes. Caller must set app.owner_id from
  // the result before inserting devices / burning the code.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION app.lookup_pairing_code(p_code_hash text)
    RETURNS TABLE (
      pairing_code_id uuid,
      owner_id uuid,
      expires_at timestamptz
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, app
    AS $fn$
    BEGIN
      RETURN QUERY
      SELECT
        pc.id,
        pc.owner_id,
        pc.expires_at
      FROM pairing_codes pc
      WHERE pc.code_hash = p_code_hash
        AND pc.used_at IS NULL
        AND pc.expires_at > now();
    END;
    $fn$;

    REVOKE ALL ON FUNCTION app.lookup_pairing_code(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.lookup_pairing_code(text) TO sms_app;
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = async (pgm) => {
  pgm.sql(`DROP FUNCTION IF EXISTS app.lookup_pairing_code(text)`);
  pgm.sql(`DROP FUNCTION IF EXISTS app.lookup_device_for_auth(uuid)`);

  for (const table of [...OWNED_TABLES].reverse()) {
    pgm.sql(`DROP POLICY IF EXISTS owner_isolation ON ${table}`);
    pgm.sql(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
    pgm.sql(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
  }

  pgm.sql(`DROP FUNCTION IF EXISTS app.current_owner_id()`);
};
