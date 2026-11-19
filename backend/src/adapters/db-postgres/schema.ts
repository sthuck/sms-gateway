/**
 * Drizzle schema for the SMS Gateway Postgres database.
 *
 * Source of truth for tables/columns/indexes/policies that Drizzle can express.
 * Things Drizzle cannot express (FORCE RLS, sms_app LOGIN/NOBYPASSRLS + password,
 * GRANT CONNECT / default privileges, app.current_owner_id(), trigger
 * app.users_set_owner_id, SECURITY DEFINER lookups + REVOKE/GRANT EXECUTE) live
 * as custom SQL in the hand-reviewed baseline under `drizzle/`.
 *
 * Never use `drizzle-kit push`. Apply via `pnpm migrate:up` only.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  inet,
  jsonb,
  pgEnum,
  pgPolicy,
  pgRole,
  pgSchema,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import ownedTablesJson from "./owned-tables.json" with { type: "json" };

/** Application role — created in baseline custom SQL; kit must not manage it. */
export const smsAppRole = pgRole("sms_app").existing();

const ownerIsolation = {
  as: "permissive" as const,
  for: "all" as const,
  to: smsAppRole,
  using: sql`owner_id = app.current_owner_id()`,
  withCheck: sql`owner_id = app.current_owner_id()`,
};

/** bytea column helper (message ciphertext). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const deviceStatus = pgEnum("device_status", ["active", "revoked"]);
export const messageDirection = pgEnum("message_direction", ["inbound", "outbound"]);
export const streamMode = pgEnum("stream_mode", ["rules", "ai", "hybrid"]);
export const streamBackfillStatus = pgEnum("stream_backfill_status", [
  "pending",
  "running",
  "completed",
  "failed",
]);
export const matchedBy = pgEnum("matched_by", ["rule", "ai"]);
export const agentClientKind = pgEnum("agent_client_kind", ["api_key", "oauth"]);
export const auditActorType = pgEnum("audit_actor_type", ["user", "device", "agent"]);

export const appSchema = pgSchema("app");

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").notNull(),
    email: text("email").notNull(),
    mfaEnrolled: boolean("mfa_enrolled").notNull().default(false),
    encryptionKeyRef: text("encryption_key_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastAuthMethod: text("last_auth_method"),
    displayName: text("display_name"),
  },
  (t) => [
    check("users_owner_self", sql`${t.ownerId} = ${t.id}`),
    pgPolicy("owner_isolation", ownerIsolation),
  ],
).enableRLS();

export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    issuer: text("issuer").notNull(),
    sub: text("sub").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("user_identities_issuer_sub_unique").on(t.issuer, t.sub),
    index("idx_user_identities_owner").on(t.ownerId),
    pgPolicy("owner_isolation", ownerIsolation),
  ],
).enableRLS();

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platformInfo: jsonb("platform_info")
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    status: deviceStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_devices_owner").on(t.ownerId), pgPolicy("owner_isolation", ownerIsolation)],
).enableRLS();

export const deviceCredentials = pgTable(
  "device_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    /** ES256 P-256 SPKI public key, unpadded base64url. */
    publicKey: text("public_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    unique("device_credentials_device_unique").on(t.deviceId),
    index("idx_device_credentials_owner").on(t.ownerId),
    pgPolicy("owner_isolation", ownerIsolation),
  ],
).enableRLS();

export const pairingCodes = pgTable(
  "pairing_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Store only a hash of the code; never the plaintext. */
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("pairing_codes_hash_unique").on(t.codeHash),
    index("idx_pairing_codes_owner").on(t.ownerId),
    index("idx_pairing_codes_expires")
      .on(t.expiresAt)
      .where(sql`${t.usedAt} IS NULL`),
    pgPolicy("owner_isolation", ownerIsolation),
  ],
).enableRLS();

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    deviceMsgId: varchar("device_msg_id", { length: 128 }).notNull(),
    sender: varchar("sender", { length: 64 }).notNull(),
    bodyCiphertext: bytea("body_ciphertext").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    simSlot: integer("sim_slot"),
    direction: messageDirection("direction").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("messages_device_msg_unique").on(t.deviceId, t.deviceMsgId),
    check("messages_sim_slot_nonnegative", sql`${t.simSlot} IS NULL OR ${t.simSlot} >= 0`),
    index("idx_messages_owner_received").on(t.ownerId, t.receivedAt.desc().nullsFirst()),
    index("idx_messages_device").on(t.deviceId),
    pgPolicy("owner_isolation", ownerIsolation),
  ],
).enableRLS();

/**
 * Per-user data-encryption keys (DEKs), wrapped by a KEK (STH-20).
 * PK (owner_id, dek_version): old versions retained so historical ciphertext decrypts.
 */
export const userKeys = pgTable(
  "user_keys",
  {
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    wrappedDek: bytea("wrapped_dek").notNull(),
    kekId: text("kek_id").notNull(),
    dekVersion: integer("dek_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "user_keys_pkey", columns: [t.ownerId, t.dekVersion] }),
    check("user_keys_dek_version_positive", sql`${t.dekVersion} >= 1`),
    index("idx_user_keys_owner").on(t.ownerId),
    pgPolicy("owner_isolation", ownerIsolation),
  ],
).enableRLS();

export const streams = pgTable(
  "streams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mode: streamMode("mode").notNull(),
    rulesJson: jsonb("rules_json")
      .notNull()
      .default(sql`'[]'::jsonb`),
    aiPrompt: text("ai_prompt"),
    version: integer("version").notNull().default(1),
    backfillStatus: streamBackfillStatus("backfill_status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("streams_version_positive", sql`${t.version} >= 1`),
    index("idx_streams_owner").on(t.ownerId),
    pgPolicy("owner_isolation", ownerIsolation),
  ],
).enableRLS();

export const streamMembership = pgTable(
  "stream_membership",
  {
    streamId: uuid("stream_id")
      .notNull()
      .references(() => streams.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    matchedBy: matchedBy("matched_by").notNull(),
    confidence: real("confidence"),
    streamVersion: integer("stream_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "stream_membership_pkey", columns: [t.streamId, t.messageId] }),
    check("stream_membership_version_positive", sql`${t.streamVersion} >= 1`),
    index("idx_stream_membership_stream").on(t.streamId, t.createdAt.desc().nullsFirst()),
    index("idx_stream_membership_message").on(t.messageId),
    index("idx_stream_membership_owner").on(t.ownerId),
    pgPolicy("owner_isolation", ownerIsolation),
  ],
).enableRLS();

export const agentClients = pgTable(
  "agent_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: agentClientKind("kind").notNull(),
    keyHash: text("key_hash"),
    keyPrefix: text("key_prefix"),
    clientId: text("client_id"),
    redirectUris: text("redirect_uris")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "agent_clients_api_key_fields",
      sql`${t.kind} <> 'api_key' OR (${t.keyHash} IS NOT NULL AND ${t.keyPrefix} IS NOT NULL)`,
    ),
    check("agent_clients_oauth_fields", sql`${t.kind} <> 'oauth' OR ${t.clientId} IS NOT NULL`),
    index("idx_agent_clients_owner").on(t.ownerId),
    index("idx_agent_clients_key_prefix")
      .on(t.keyPrefix)
      .where(sql`${t.keyPrefix} IS NOT NULL`),
    index("idx_agent_clients_client_id")
      .on(t.clientId)
      .where(sql`${t.clientId} IS NOT NULL`),
    pgPolicy("owner_isolation", ownerIsolation),
  ],
).enableRLS();

export const agentGrants = pgTable(
  "agent_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentClientId: uuid("agent_client_id")
      .notNull()
      .references(() => agentClients.id, { onDelete: "cascade" }),
    streamId: uuid("stream_id")
      .notNull()
      .references(() => streams.id, { onDelete: "cascade" }),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`ARRAY['stream:read']::text[]`),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    unique("agent_grants_client_stream_unique").on(t.agentClientId, t.streamId),
    index("idx_agent_grants_owner").on(t.ownerId),
    index("idx_agent_grants_client").on(t.agentClientId),
    index("idx_agent_grants_stream").on(t.streamId),
    pgPolicy("owner_isolation", ownerIsolation),
  ],
).enableRLS();

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorType: auditActorType("actor_type").notNull(),
    actorId: uuid("actor_id").notNull(),
    action: text("action").notNull(),
    streamId: uuid("stream_id").references(() => streams.id, { onDelete: "set null" }),
    messageCount: integer("message_count"),
    ip: inet("ip"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_audit_log_owner_at").on(t.ownerId, t.at.desc().nullsFirst()),
    pgPolicy("owner_isolation", ownerIsolation),
  ],
).enableRLS();

export const senderAiOptout = pgTable(
  "sender_ai_optout",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    senderPattern: text("sender_pattern").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("sender_ai_optout_owner_pattern_unique").on(t.ownerId, t.senderPattern),
    index("idx_sender_ai_optout_owner").on(t.ownerId),
    pgPolicy("owner_isolation", ownerIsolation),
  ],
).enableRLS();

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 hex of the opaque session id presented in the cookie. */
    sessionIdHash: text("session_id_hash").notNull(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("sessions_hash_unique").on(t.sessionIdHash),
    index("idx_sessions_owner").on(t.ownerId),
    index("idx_sessions_expires")
      .on(t.expiresAt)
      .where(sql`${t.revokedAt} IS NULL`),
    pgPolicy("owner_isolation", ownerIsolation),
  ],
).enableRLS();

export const queueProcessedJobs = pgTable(
  "queue_processed_jobs",
  {
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    jobName: text("job_name").notNull(),
    jobId: uuid("job_id"),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "queue_processed_jobs_pkey", columns: [t.ownerId, t.dedupeKey] }),
    index("queue_processed_jobs_owner_processed_at_idx").on(
      t.ownerId,
      t.processedAt.desc().nullsFirst(),
    ),
    pgPolicy("owner_isolation", ownerIsolation),
  ],
).enableRLS();

/** Non-RLS shared tables in schema `app` (device auth support). */
export const deviceReplayCache = appSchema.table(
  "device_replay_cache",
  {
    identity: text("identity").notNull(),
    kind: text("kind").notNull(),
    valueHash: text("value_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: "device_replay_cache_pkey", columns: [t.identity, t.kind, t.valueHash] }),
    check("device_replay_cache_kind_check", sql`${t.kind} IN ('nonce', 'signature')`),
    index("idx_device_replay_expires").on(t.expiresAt),
  ],
);

export const rateLimitBuckets = appSchema.table("rate_limit_buckets", {
  bucketKey: text("bucket_key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  hitCount: integer("hit_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});

/** Tables with owner_id that must have FORCE ROW LEVEL SECURITY (custom SQL). */
export const OWNED_TABLES = ownedTablesJson as unknown as readonly [
  "users",
  "user_identities",
  "devices",
  "device_credentials",
  "pairing_codes",
  "messages",
  "user_keys",
  "streams",
  "stream_membership",
  "agent_clients",
  "agent_grants",
  "audit_log",
  "sender_ai_optout",
  "sessions",
  "queue_processed_jobs",
];

/**
 * Minimum owned-table count after the baseline (legacy stamp / pre-0001).
 * Later migrations may add tables (e.g. user_keys); OWNED_TABLES.length grows.
 */
export const OWNED_TABLE_FORCE_RLS_FLOOR = 14;
