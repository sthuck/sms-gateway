ALTER TABLE "owner_access_tokens" ADD COLUMN "expires_at" timestamp with time zone;
--> statement-breakpoint
-- Recreate pre-owner PAT lookup to expose expires_at (same 401 path for expired).
DROP FUNCTION IF EXISTS app.lookup_owner_access_token(uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lookup_owner_access_token(p_token_id uuid)
RETURNS TABLE (
  token_id uuid,
  owner_id uuid,
  token_hash text,
  revoked_at timestamptz,
  last_used_at timestamptz,
  expires_at timestamptz
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
    t.last_used_at,
    t.expires_at
  FROM owner_access_tokens t
  WHERE t.id = p_token_id;
END;
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lookup_owner_access_token(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lookup_owner_access_token(uuid) TO sms_app;
