CREATE TABLE "user_keys" (
	"owner_id" uuid NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"kek_id" text NOT NULL,
	"dek_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_keys_pkey" PRIMARY KEY("owner_id","dek_version"),
	CONSTRAINT "user_keys_dek_version_positive" CHECK ("user_keys"."dek_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "user_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_keys" ADD CONSTRAINT "user_keys_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_keys_owner" ON "user_keys" USING btree ("owner_id");--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "user_keys" AS PERMISSIVE FOR ALL TO "sms_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());
--> statement-breakpoint
-- FORCE RLS: required for every owner_id table (Drizzle cannot emit this).
ALTER TABLE "user_keys" FORCE ROW LEVEL SECURITY;