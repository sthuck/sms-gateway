/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = async (pgm) => {
  // Role created without a password here. scripts/migrate.mjs sets the
  // password once on first create (SMS_APP_PASSWORD required). Later
  // migrate:up runs never ALTER ROLE … PASSWORD — rotate manually.
  pgm.sql(`
    DO $role$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'sms_app') THEN
        CREATE ROLE sms_app
          LOGIN
          NOSUPERUSER
          NOCREATEDB
          NOCREATEROLE
          NOREPLICATION
          NOBYPASSRLS;
      ELSE
        ALTER ROLE sms_app WITH
          LOGIN
          NOSUPERUSER
          NOCREATEDB
          NOCREATEROLE
          NOREPLICATION
          NOBYPASSRLS;
      END IF;
    END
    $role$;
  `);

  pgm.sql(`
    DO $grant$
    BEGIN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO sms_app', current_database());
    END
    $grant$;
  `);

  pgm.createSchema("app", { ifNotExists: true });
  pgm.sql(`GRANT USAGE ON SCHEMA app TO sms_app`);
  pgm.sql(`GRANT USAGE ON SCHEMA public TO sms_app`);

  pgm.sql(`
    CREATE TYPE device_status AS ENUM ('active', 'revoked');
    CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
    CREATE TYPE stream_mode AS ENUM ('rules', 'ai', 'hybrid');
    CREATE TYPE stream_backfill_status AS ENUM ('pending', 'running', 'completed', 'failed');
    CREATE TYPE matched_by AS ENUM ('rule', 'ai');
    CREATE TYPE agent_client_kind AS ENUM ('api_key', 'oauth');
    CREATE TYPE audit_actor_type AS ENUM ('user', 'device', 'agent');
  `);

  pgm.sql(`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL,
      email TEXT NOT NULL,
      mfa_enrolled BOOLEAN NOT NULL DEFAULT FALSE,
      encryption_key_ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT users_owner_self CHECK (owner_id = id)
    );

    CREATE OR REPLACE FUNCTION app.users_set_owner_id()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF NEW.owner_id IS NULL THEN
        NEW.owner_id := NEW.id;
      END IF;
      RETURN NEW;
    END;
    $fn$;

    CREATE TRIGGER users_set_owner_id
      BEFORE INSERT ON users
      FOR EACH ROW
      EXECUTE FUNCTION app.users_set_owner_id();

    CREATE TABLE user_identities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      issuer TEXT NOT NULL,
      sub TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT user_identities_issuer_sub_unique UNIQUE (issuer, sub)
    );

    CREATE TABLE devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      platform_info JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_seen_at TIMESTAMPTZ,
      status device_status NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE device_credentials (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      device_id UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
      -- ES256 P-256 SPKI public key, unpadded base64url (see docs/contracts/device-signing.md)
      public_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      CONSTRAINT device_credentials_device_unique UNIQUE (device_id)
    );

    CREATE TABLE pairing_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      -- Store only a hash of the code; never the plaintext code.
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pairing_codes_hash_unique UNIQUE (code_hash)
    );

    CREATE TABLE messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      device_id UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
      device_msg_id VARCHAR(128) NOT NULL,
      sender VARCHAR(64) NOT NULL,
      body_ciphertext BYTEA NOT NULL,
      received_at TIMESTAMPTZ NOT NULL,
      sim_slot INTEGER,
      direction message_direction NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT messages_device_msg_unique UNIQUE (device_id, device_msg_id),
      CONSTRAINT messages_sim_slot_nonnegative CHECK (sim_slot IS NULL OR sim_slot >= 0)
    );

    CREATE TABLE streams (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mode stream_mode NOT NULL,
      rules_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      ai_prompt TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      backfill_status stream_backfill_status NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT streams_version_positive CHECK (version >= 1)
    );

    CREATE TABLE stream_membership (
      stream_id UUID NOT NULL REFERENCES streams (id) ON DELETE CASCADE,
      message_id UUID NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
      owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      matched_by matched_by NOT NULL,
      confidence REAL,
      stream_version INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (stream_id, message_id),
      CONSTRAINT stream_membership_version_positive CHECK (stream_version >= 1)
    );

    CREATE TABLE agent_clients (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind agent_client_kind NOT NULL,
      key_hash TEXT,
      key_prefix TEXT,
      client_id TEXT,
      redirect_uris TEXT[] NOT NULL DEFAULT '{}',
      expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT agent_clients_api_key_fields CHECK (
        kind <> 'api_key' OR (key_hash IS NOT NULL AND key_prefix IS NOT NULL)
      ),
      CONSTRAINT agent_clients_oauth_fields CHECK (
        kind <> 'oauth' OR client_id IS NOT NULL
      )
    );

    CREATE TABLE agent_grants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      agent_client_id UUID NOT NULL REFERENCES agent_clients (id) ON DELETE CASCADE,
      stream_id UUID NOT NULL REFERENCES streams (id) ON DELETE CASCADE,
      scopes TEXT[] NOT NULL DEFAULT ARRAY['stream:read']::text[],
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      CONSTRAINT agent_grants_client_stream_unique UNIQUE (agent_client_id, stream_id)
    );

    CREATE TABLE audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      actor_type audit_actor_type NOT NULL,
      actor_id UUID NOT NULL,
      action TEXT NOT NULL,
      stream_id UUID REFERENCES streams (id) ON DELETE SET NULL,
      message_count INTEGER,
      ip INET,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE sender_ai_optout (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      sender_pattern TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT sender_ai_optout_owner_pattern_unique UNIQUE (owner_id, sender_pattern)
    );
  `);

  pgm.sql(`
    CREATE INDEX idx_user_identities_owner ON user_identities (owner_id);
    CREATE INDEX idx_devices_owner ON devices (owner_id);
    CREATE INDEX idx_device_credentials_owner ON device_credentials (owner_id);
    CREATE INDEX idx_pairing_codes_owner ON pairing_codes (owner_id);
    CREATE INDEX idx_pairing_codes_expires ON pairing_codes (expires_at)
      WHERE used_at IS NULL;
    CREATE INDEX idx_messages_owner_received ON messages (owner_id, received_at DESC);
    CREATE INDEX idx_messages_device ON messages (device_id);
    CREATE INDEX idx_streams_owner ON streams (owner_id);
    CREATE INDEX idx_stream_membership_stream ON stream_membership (stream_id, created_at DESC);
    CREATE INDEX idx_stream_membership_message ON stream_membership (message_id);
    CREATE INDEX idx_stream_membership_owner ON stream_membership (owner_id);
    CREATE INDEX idx_agent_clients_owner ON agent_clients (owner_id);
    CREATE INDEX idx_agent_clients_key_prefix ON agent_clients (key_prefix)
      WHERE key_prefix IS NOT NULL;
    CREATE INDEX idx_agent_clients_client_id ON agent_clients (client_id)
      WHERE client_id IS NOT NULL;
    CREATE INDEX idx_agent_grants_owner ON agent_grants (owner_id);
    CREATE INDEX idx_agent_grants_client ON agent_grants (agent_client_id);
    CREATE INDEX idx_agent_grants_stream ON agent_grants (stream_id);
    CREATE INDEX idx_audit_log_owner_at ON audit_log (owner_id, at DESC);
    CREATE INDEX idx_sender_ai_optout_owner ON sender_ai_optout (owner_id);
  `);

  pgm.sql(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sms_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sms_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sms_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO sms_app;
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = async (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS sender_ai_optout CASCADE;
    DROP TABLE IF EXISTS audit_log CASCADE;
    DROP TABLE IF EXISTS agent_grants CASCADE;
    DROP TABLE IF EXISTS agent_clients CASCADE;
    DROP TABLE IF EXISTS stream_membership CASCADE;
    DROP TABLE IF EXISTS streams CASCADE;
    DROP TABLE IF EXISTS messages CASCADE;
    DROP TABLE IF EXISTS pairing_codes CASCADE;
    DROP TABLE IF EXISTS device_credentials CASCADE;
    DROP TABLE IF EXISTS devices CASCADE;
    DROP TABLE IF EXISTS user_identities CASCADE;
    DROP TABLE IF EXISTS users CASCADE;

    DROP TYPE IF EXISTS audit_actor_type;
    DROP TYPE IF EXISTS agent_client_kind;
    DROP TYPE IF EXISTS matched_by;
    DROP TYPE IF EXISTS stream_backfill_status;
    DROP TYPE IF EXISTS stream_mode;
    DROP TYPE IF EXISTS message_direction;
    DROP TYPE IF EXISTS device_status;

    DROP FUNCTION IF EXISTS app.users_set_owner_id();
    DROP SCHEMA IF EXISTS app CASCADE;
  `);

  // Leave sms_app in place on down: passwords/grants may be managed outside
  // migrations, and dropping a LOGIN role mid-downgrade can break open pools.
  // Operators who want a full teardown can DROP ROLE sms_app manually.
};
