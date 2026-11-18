CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TYPE "public"."agent_client_kind" AS ENUM('api_key', 'oauth');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'device', 'agent');--> statement-breakpoint
CREATE TYPE "public"."device_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."matched_by" AS ENUM('rule', 'ai');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."stream_backfill_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."stream_mode" AS ENUM('rules', 'ai', 'hybrid');--> statement-breakpoint
CREATE TABLE "agent_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "agent_client_kind" NOT NULL,
	"key_hash" text,
	"key_prefix" text,
	"client_id" text,
	"redirect_uris" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_clients_api_key_fields" CHECK ("agent_clients"."kind" <> 'api_key' OR ("agent_clients"."key_hash" IS NOT NULL AND "agent_clients"."key_prefix" IS NOT NULL)),
	CONSTRAINT "agent_clients_oauth_fields" CHECK ("agent_clients"."kind" <> 'oauth' OR "agent_clients"."client_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "agent_clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_client_id" uuid NOT NULL,
	"stream_id" uuid NOT NULL,
	"scopes" text[] DEFAULT ARRAY['stream:read']::text[] NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_grants_client_stream_unique" UNIQUE("agent_client_id","stream_id")
);
--> statement-breakpoint
ALTER TABLE "agent_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"stream_id" uuid,
	"message_count" integer,
	"ip" "inet",
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "device_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "device_credentials_device_unique" UNIQUE("device_id")
);
--> statement-breakpoint
ALTER TABLE "device_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."device_replay_cache" (
	"identity" text NOT NULL,
	"kind" text NOT NULL,
	"value_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "device_replay_cache_pkey" PRIMARY KEY("identity","kind","value_hash"),
	CONSTRAINT "device_replay_cache_kind_check" CHECK ("app"."device_replay_cache"."kind" IN ('nonce', 'signature'))
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"status" "device_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"device_msg_id" varchar(128) NOT NULL,
	"sender" varchar(64) NOT NULL,
	"body_ciphertext" "bytea" NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"sim_slot" integer,
	"direction" "message_direction" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_device_msg_unique" UNIQUE("device_id","device_msg_id"),
	CONSTRAINT "messages_sim_slot_nonnegative" CHECK ("messages"."sim_slot" IS NULL OR "messages"."sim_slot" >= 0)
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pairing_codes_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "pairing_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "queue_processed_jobs" (
	"owner_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"job_name" text NOT NULL,
	"job_id" uuid,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_processed_jobs_pkey" PRIMARY KEY("owner_id","dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "queue_processed_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."rate_limit_buckets" (
	"bucket_key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sender_ai_optout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"sender_pattern" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sender_ai_optout_owner_pattern_unique" UNIQUE("owner_id","sender_pattern")
);
--> statement-breakpoint
ALTER TABLE "sender_ai_optout" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"session_id_hash" text NOT NULL,
	"csrf_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_hash_unique" UNIQUE("session_id_hash")
);
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stream_membership" (
	"stream_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"matched_by" "matched_by" NOT NULL,
	"confidence" real,
	"stream_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stream_membership_pkey" PRIMARY KEY("stream_id","message_id"),
	CONSTRAINT "stream_membership_version_positive" CHECK ("stream_membership"."stream_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "stream_membership" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "streams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mode" "stream_mode" NOT NULL,
	"rules_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_prompt" text,
	"version" integer DEFAULT 1 NOT NULL,
	"backfill_status" "stream_backfill_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "streams_version_positive" CHECK ("streams"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "streams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"sub" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_issuer_sub_unique" UNIQUE("issuer","sub")
);
--> statement-breakpoint
ALTER TABLE "user_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"email" text NOT NULL,
	"mfa_enrolled" boolean DEFAULT false NOT NULL,
	"encryption_key_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_auth_method" text,
	"display_name" text,
	CONSTRAINT "users_owner_self" CHECK ("users"."owner_id" = "users"."id")
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_clients" ADD CONSTRAINT "agent_clients_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "public"."agent_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_stream_id_fkey" FOREIGN KEY ("stream_id") REFERENCES "public"."streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_stream_id_fkey" FOREIGN KEY ("stream_id") REFERENCES "public"."streams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_processed_jobs" ADD CONSTRAINT "queue_processed_jobs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_ai_optout" ADD CONSTRAINT "sender_ai_optout_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_membership" ADD CONSTRAINT "stream_membership_stream_id_fkey" FOREIGN KEY ("stream_id") REFERENCES "public"."streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_membership" ADD CONSTRAINT "stream_membership_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_membership" ADD CONSTRAINT "stream_membership_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streams" ADD CONSTRAINT "streams_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_clients_owner" ON "agent_clients" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_agent_clients_key_prefix" ON "agent_clients" USING btree ("key_prefix") WHERE "agent_clients"."key_prefix" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_agent_clients_client_id" ON "agent_clients" USING btree ("client_id") WHERE "agent_clients"."client_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_agent_grants_owner" ON "agent_grants" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_agent_grants_client" ON "agent_grants" USING btree ("agent_client_id");--> statement-breakpoint
CREATE INDEX "idx_agent_grants_stream" ON "agent_grants" USING btree ("stream_id");--> statement-breakpoint
CREATE INDEX "idx_audit_log_owner_at" ON "audit_log" USING btree ("owner_id","at" DESC);--> statement-breakpoint
CREATE INDEX "idx_device_credentials_owner" ON "device_credentials" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_device_replay_expires" ON "app"."device_replay_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_devices_owner" ON "devices" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_messages_owner_received" ON "messages" USING btree ("owner_id","received_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_messages_device" ON "messages" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "idx_pairing_codes_owner" ON "pairing_codes" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_pairing_codes_expires" ON "pairing_codes" USING btree ("expires_at") WHERE "pairing_codes"."used_at" IS NULL;--> statement-breakpoint
CREATE INDEX "queue_processed_jobs_owner_processed_at_idx" ON "queue_processed_jobs" USING btree ("owner_id","processed_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_sender_ai_optout_owner" ON "sender_ai_optout" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_owner" ON "sessions" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_expires" ON "sessions" USING btree ("expires_at") WHERE "sessions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_stream_membership_stream" ON "stream_membership" USING btree ("stream_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_stream_membership_message" ON "stream_membership" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_stream_membership_owner" ON "stream_membership" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_streams_owner" ON "streams" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_user_identities_owner" ON "user_identities" USING btree ("owner_id");--> statement-breakpoint
-- =============================================================================
-- Custom SQL (hand-reviewed): things Drizzle cannot express.
-- See docs/schema.md and backend/drizzle/README.md.
-- =============================================================================

-- Role sms_app: LOGIN, NOBYPASSRLS. Password is set only by migrate.mjs when
-- the role is newly created (SMS_APP_PASSWORD required). Never ALTER … PASSWORD here.
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
--> statement-breakpoint
DO $grant$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO sms_app', current_database());
END
$grant$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO sms_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO sms_app;
--> statement-breakpoint
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.current_owner_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_owner_id() TO sms_app;
--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "agent_clients" AS PERMISSIVE FOR ALL TO "sms_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "agent_grants" AS PERMISSIVE FOR ALL TO "sms_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "audit_log" AS PERMISSIVE FOR ALL TO "sms_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "device_credentials" AS PERMISSIVE FOR ALL TO "sms_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "devices" AS PERMISSIVE FOR ALL TO "sms_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "messages" AS PERMISSIVE FOR ALL TO "sms_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "pairing_codes" AS PERMISSIVE FOR ALL TO "sms_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "queue_processed_jobs" AS PERMISSIVE FOR ALL TO "sms_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "sender_ai_optout" AS PERMISSIVE FOR ALL TO "sms_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "sessions" AS PERMISSIVE FOR ALL TO "sms_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "stream_membership" AS PERMISSIVE FOR ALL TO "sms_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "streams" AS PERMISSIVE FOR ALL TO "sms_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "user_identities" AS PERMISSIVE FOR ALL TO "sms_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "users" AS PERMISSIVE FOR ALL TO "sms_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());--> statement-breakpoint
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
--> statement-breakpoint
DROP TRIGGER IF EXISTS users_set_owner_id ON users;
--> statement-breakpoint
CREATE TRIGGER users_set_owner_id
  BEFORE INSERT ON users
  FOR EACH ROW
  EXECUTE FUNCTION app.users_set_owner_id();
--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_identities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE device_credentials FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pairing_codes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE streams FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stream_membership FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_clients FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sender_ai_optout FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE queue_processed_jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lookup_device_for_auth(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lookup_device_for_auth(uuid) TO sms_app;
--> statement-breakpoint
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lookup_pairing_code(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lookup_pairing_code(text) TO sms_app;
--> statement-breakpoint
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lookup_user_identity(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lookup_user_identity(text, text) TO sms_app;
--> statement-breakpoint
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lookup_session(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lookup_session(text) TO sms_app;
--> statement-breakpoint
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lookup_user_by_email(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lookup_user_by_email(text) TO sms_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sms_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sms_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sms_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sms_app;
--> statement-breakpoint
REVOKE ALL ON TABLE app.device_replay_cache FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE app.rate_limit_buckets FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.device_replay_cache TO sms_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.rate_limit_buckets TO sms_app;
