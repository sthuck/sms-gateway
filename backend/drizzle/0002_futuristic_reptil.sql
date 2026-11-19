CREATE TABLE "owner_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "owner_access_tokens_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "owner_access_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "owner_access_tokens" ADD CONSTRAINT "owner_access_tokens_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_owner_access_tokens_owner" ON "owner_access_tokens" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_owner_access_tokens_owner_active" ON "owner_access_tokens" USING btree ("owner_id") WHERE "owner_access_tokens"."revoked_at" IS NULL;--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "owner_access_tokens" AS PERMISSIVE FOR ALL TO "sms_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());
--> statement-breakpoint
-- FORCE RLS: required for every owner_id table (Drizzle cannot emit this).
ALTER TABLE "owner_access_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Pre-owner PAT lookup by id (includes revoked rows for uniform 401 handling).
CREATE OR REPLACE FUNCTION app.lookup_owner_access_token(p_token_id uuid)
RETURNS TABLE (
  token_id uuid,
  owner_id uuid,
  token_hash text,
  revoked_at timestamptz,
  last_used_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $fn$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.owner_id,
    t.token_hash,
    t.revoked_at,
    t.last_used_at
  FROM owner_access_tokens t
  WHERE t.id = p_token_id;
END;
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lookup_owner_access_token(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lookup_owner_access_token(uuid) TO sms_app;