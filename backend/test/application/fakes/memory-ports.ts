import type {
  IdentityRecord,
  MappedClaims,
  Session,
  User,
} from "../../../src/domain/auth/types.js";
import type { Clock } from "../../../src/ports/outbound/clock.js";
import type { IdGenerator } from "../../../src/ports/outbound/id-generator.js";
import type { IdentityRepository } from "../../../src/ports/outbound/identity-repository.js";
import type { JwtVerifier, VerifiedBearer } from "../../../src/ports/outbound/jwt-verifier.js";
import type {
  AuthorizationResult,
  AuthorizationStart,
  OidcProvider,
} from "../../../src/ports/outbound/oidc-provider.js";
import type {
  InsertSessionInput,
  SessionRepository,
} from "../../../src/ports/outbound/session-repository.js";
import type { TokenHasher } from "../../../src/ports/outbound/token-hasher.js";
import type {
  CreateUserInput,
  LinkIdentityAndUpdateInput,
  UpdateAuthProfileInput,
  UserByEmail,
  UserRepository,
} from "../../../src/ports/outbound/user-repository.js";
import type { DeviceAuthRepository } from "../../../src/ports/outbound/device-auth-repository.js";
import type { PairingCodeRepository } from "../../../src/ports/outbound/pairing-code-repository.js";
import type { ReplayCache } from "../../../src/ports/outbound/replay-cache.js";
import type { PairRateLimiter } from "../../../src/ports/outbound/pair-rate-limiter.js";
import type { QueuePublisher } from "../../../src/ports/outbound/queue-publisher.js";
import type { BodyCodec } from "../../../src/ports/outbound/body-codec.js";
import type { IngestRateLimiter } from "../../../src/ports/outbound/ingest-rate-limiter.js";
import type {
  MessageInsert,
  MessageRecord,
  MessageRepository,
  MessageUpsertRow,
} from "../../../src/ports/outbound/message-repository.js";
import type {
  InsertStreamInput,
  ListStreamMessagesInput,
  ListStreamMessagesResult,
  StreamMessageRecord,
  StreamRepository,
  UpdateStreamPatch,
} from "../../../src/ports/outbound/stream-repository.js";
import type {
  DeviceAuthRecord,
  DeviceInfo,
  DeviceMe,
  PairedDevice,
  PairingCodeRecord,
  RateLimitDecision,
} from "../../../src/domain/device/types.js";
import type { Stream } from "../../../src/domain/stream/types.js";
import { evaluateMfa, extractMfaClaims, mapClaims } from "../../../src/domain/auth/index.js";
import type { MfaPolicy } from "../../../src/domain/auth/types.js";
import { InfrastructureError } from "../../../src/domain/errors.js";

/** When set, the next port call throws InfrastructureError (fault injection). */
export type FaultSwitch = { throwInfra: boolean };

function maybeFault(fault: FaultSwitch | undefined, label: string): void {
  if (fault?.throwInfra) {
    throw new InfrastructureError(label);
  }
}

export class MemoryClock implements Clock {
  constructor(private current: Date = new Date("2026-01-01T00:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class MemoryIdGenerator implements IdGenerator {
  private n = 0;
  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${String(this.n).padStart(12, "0")}`;
  }
  randomToken(bytes = 32): string {
    this.n += 1;
    return `tok-${bytes}-${this.n}`;
  }
}

export class MemoryTokenHasher implements TokenHasher {
  hash(value: string): string {
    return `hash(${value})`;
  }
}

export class MemorySessionRepository implements SessionRepository {
  readonly byHash = new Map<string, Session>();
  fault: FaultSwitch = { throwInfra: false };

  async insert(input: InsertSessionInput): Promise<void> {
    maybeFault(this.fault, "memory session insert failed");
    this.byHash.set(input.sessionIdHash, {
      sessionRowId: `row-${this.byHash.size + 1}`,
      ownerId: input.ownerId,
      csrfTokenHash: input.csrfTokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
    });
  }

  async lookupBySessionIdHash(sessionIdHash: string): Promise<Session | null> {
    maybeFault(this.fault, "memory session lookup failed");
    return this.byHash.get(sessionIdHash) ?? null;
  }

  async revokeBySessionIdHash(ownerId: string, sessionIdHash: string): Promise<void> {
    maybeFault(this.fault, "memory session revoke failed");
    const session = this.byHash.get(sessionIdHash);
    if (session && session.ownerId === ownerId && !session.revokedAt) {
      session.revokedAt = new Date();
    }
  }

  readonly touched: string[] = [];
  async touch(_ownerId: string, sessionRowId: string): Promise<void> {
    maybeFault(this.fault, "memory session touch failed");
    this.touched.push(sessionRowId);
  }
}

export class MemoryIdentityRepository implements IdentityRepository {
  readonly rows: Array<IdentityRecord & { issuer: string; sub: string }> = [];
  fault: FaultSwitch = { throwInfra: false };

  async findByIssuerSub(issuer: string, sub: string): Promise<IdentityRecord | null> {
    maybeFault(this.fault, "memory identity lookup failed");
    return this.rows.find((r) => r.issuer === issuer && r.sub === sub) ?? null;
  }

  async link(ownerId: string, issuer: string, sub: string): Promise<void> {
    maybeFault(this.fault, "memory identity link failed");
    this.rows.push({
      identityId: `id-${this.rows.length + 1}`,
      ownerId,
      issuer,
      sub,
      email: "",
      mfaEnrolled: false,
      displayName: null,
    });
  }
}

export class MemoryUserRepository implements UserRepository {
  readonly users = new Map<string, User>();
  fault: FaultSwitch = { throwInfra: false };

  constructor(private readonly identities?: MemoryIdentityRepository) {}

  async findById(_ownerId: string, userId: string): Promise<User | null> {
    maybeFault(this.fault, "memory user findById failed");
    return this.users.get(userId) ?? null;
  }

  async findByEmail(email: string): Promise<UserByEmail | null> {
    maybeFault(this.fault, "memory user findByEmail failed");
    for (const user of this.users.values()) {
      if (user.email === email) {
        return { ownerId: user.id, email: user.email, mfaEnrolled: user.mfaEnrolled };
      }
    }
    return null;
  }

  async create(input: CreateUserInput): Promise<void> {
    maybeFault(this.fault, "memory user create failed");
    this.users.set(input.ownerId, {
      id: input.ownerId,
      email: input.email,
      mfaEnrolled: input.mfaEnrolled,
      displayName: input.displayName,
      lastAuthMethod: input.lastAuthMethod,
    });
    if (input.identity && this.identities) {
      await this.identities.link(input.ownerId, input.identity.issuer, input.identity.sub);
      const row = this.identities.rows.at(-1);
      if (row) {
        row.email = input.email;
        row.mfaEnrolled = input.mfaEnrolled;
        row.displayName = input.displayName;
      }
    }
  }

  async updateAuthProfile(input: UpdateAuthProfileInput): Promise<void> {
    maybeFault(this.fault, "memory user updateAuthProfile failed");
    const user = this.users.get(input.ownerId);
    if (!user) return;
    user.mfaEnrolled = input.mfaEnrolled;
    user.lastAuthMethod = input.lastAuthMethod;
    if (input.displayName) user.displayName = input.displayName;
    if (input.email !== undefined) user.email = input.email;
  }

  async linkIdentityAndUpdate(input: LinkIdentityAndUpdateInput): Promise<void> {
    maybeFault(this.fault, "memory user linkIdentityAndUpdate failed");
    if (this.identities) {
      await this.identities.link(input.ownerId, input.issuer, input.sub);
    }
    await this.updateAuthProfile({
      ownerId: input.ownerId,
      mfaEnrolled: input.mfaEnrolled,
      lastAuthMethod: input.lastAuthMethod,
      displayName: input.displayName,
    });
  }
}

export class StubOidcProvider implements OidcProvider {
  failFinish: Error | null = null;
  nextResult: AuthorizationResult | null = null;
  claimMapping = { email: "email", name: "name" };
  mfaPolicy: MfaPolicy = { requireMfa: true, claimsMissing: "deny" };

  async startAuthorization(): Promise<AuthorizationStart> {
    return { redirectUrl: "https://idp.example/authorize", sealedState: "sealed" };
  }

  async finishAuthorization(_callbackUrl: URL, _sealedState: string): Promise<AuthorizationResult> {
    if (this.failFinish) throw this.failFinish;
    if (this.nextResult) return this.nextResult;
    const raw = {
      sub: "sub-1",
      email: "a@example.com",
      name: "Ada",
      amr: ["pwd", "otp"],
      iss: "https://idp.example",
    };
    return {
      claims: mapClaims(raw, this.claimMapping),
      mfa: evaluateMfa(extractMfaClaims(raw), this.mfaPolicy),
      issuer: "https://idp.example",
    };
  }

  setClaims(raw: Record<string, unknown>, issuer = "https://idp.example"): void {
    this.nextResult = {
      claims: mapClaims(raw, this.claimMapping),
      mfa: evaluateMfa(extractMfaClaims(raw), this.mfaPolicy),
      issuer,
    };
  }
}

export class StubJwtVerifier implements JwtVerifier {
  fail: Error | null = null;
  next: VerifiedBearer | null = null;

  async verify(_token: string): Promise<VerifiedBearer> {
    if (this.fail) throw this.fail;
    if (!this.next) throw new Error("no token stub");
    return this.next;
  }
}

export function mapped(
  partial: Partial<MappedClaims> & { sub: string; email: string },
): MappedClaims {
  return {
    name: null,
    amr: null,
    acr: null,
    raw: {},
    ...partial,
  };
}

export class MemoryDeviceAuthRepository implements DeviceAuthRepository {
  readonly byId = new Map<string, DeviceAuthRecord>();
  fault: FaultSwitch = { throwInfra: false };

  async lookupForAuth(deviceId: string): Promise<DeviceAuthRecord | null> {
    maybeFault(this.fault, "memory device lookup failed");
    return this.byId.get(deviceId) ?? null;
  }

  async pairWithBurnedCode(input: {
    ownerId: string;
    pairingCodeId: string;
    displayName: string;
    publicKey: string;
    deviceInfo: DeviceInfo;
    clientIp: string;
  }): Promise<PairedDevice | null> {
    maybeFault(this.fault, "memory device pair failed");
    if (input.pairingCodeId === "lost-race") return null;
    const id = `dev-${this.byId.size + 1}`;
    this.byId.set(id, {
      deviceId: id,
      ownerId: input.ownerId,
      status: "active",
      publicKey: input.publicKey,
      credentialRevokedAt: null,
    });
    return {
      deviceId: id,
      name: input.displayName,
      status: "active",
      pairedAt: new Date().toISOString(),
    };
  }

  async findMe(ownerId: string, deviceId: string): Promise<DeviceMe | null> {
    maybeFault(this.fault, "memory device me failed");
    const row = this.byId.get(deviceId);
    if (!row || row.ownerId !== ownerId) return null;
    return {
      deviceId: row.deviceId,
      name: "mem",
      status: row.status,
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revokedAt: row.credentialRevokedAt?.toISOString() ?? null,
    };
  }

  async revoke(ownerId: string, deviceId: string, _clientIp: string): Promise<"ok" | "missing"> {
    maybeFault(this.fault, "memory device revoke failed");
    const row = this.byId.get(deviceId);
    if (!row || row.ownerId !== ownerId) return "missing";
    row.status = "revoked";
    row.credentialRevokedAt = new Date();
    return "ok";
  }
}

export class MemoryPairingCodeRepository implements PairingCodeRepository {
  readonly byHash = new Map<string, PairingCodeRecord>();
  fault: FaultSwitch = { throwInfra: false };

  async lookupByHash(codeHash: string): Promise<PairingCodeRecord | null> {
    maybeFault(this.fault, "memory pairing lookup failed");
    return this.byHash.get(codeHash) ?? null;
  }

  async insert(input: {
    ownerId: string;
    codeHash: string;
    ttlSeconds: number;
  }): Promise<{ id: string; expiresAt: Date }> {
    maybeFault(this.fault, "memory pairing insert failed");
    const id = `pc-${this.byHash.size + 1}`;
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
    this.byHash.set(input.codeHash, {
      pairingCodeId: id,
      ownerId: input.ownerId,
      expiresAt,
    });
    return { id, expiresAt };
  }

  async burn(_ownerId: string, pairingCodeId: string): Promise<boolean> {
    maybeFault(this.fault, "memory pairing burn failed");
    for (const [hash, row] of this.byHash) {
      if (row.pairingCodeId === pairingCodeId) {
        this.byHash.delete(hash);
        return true;
      }
    }
    return false;
  }
}

export class MemoryReplayCache implements ReplayCache {
  readonly seen = new Set<string>();
  fault: FaultSwitch = { throwInfra: false };

  async claimNonceAndSignature(
    identity: string,
    nonce: string,
    signature: string,
    _ttlSeconds?: number,
  ): Promise<"ok" | "replay"> {
    maybeFault(this.fault, "memory replay claim failed");
    const key = `${identity}:${nonce}:${signature}`;
    if (this.seen.has(key)) return "replay";
    this.seen.add(key);
    return "ok";
  }
}

export class MemoryPairRateLimiter implements PairRateLimiter {
  fault: FaultSwitch = { throwInfra: false };
  allow = true;

  async checkIpAllowed(_ip: string): Promise<RateLimitDecision> {
    maybeFault(this.fault, "memory rate limit ip failed");
    return {
      allowed: this.allow,
      limit: 10,
      remaining: this.allow ? 9 : 0,
      resetSec: 60,
      retryAfterSec: this.allow ? 0 : 60,
    };
  }

  async checkGlobalInvalidAllowed(): Promise<RateLimitDecision> {
    maybeFault(this.fault, "memory rate limit global failed");
    return {
      allowed: this.allow,
      limit: 120,
      remaining: this.allow ? 119 : 0,
      resetSec: 60,
      retryAfterSec: this.allow ? 0 : 60,
    };
  }

  async noteInvalidCode(_ip: string): Promise<void> {
    maybeFault(this.fault, "memory note invalid failed");
  }
}

export class MemoryQueuePublisher implements QueuePublisher {
  fault: FaultSwitch = { throwInfra: false };
  published: unknown[] = [];

  async publishInTx(
    _tx: unknown,
    event: { type: string; owner_id: string; [key: string]: unknown },
    _options?: { singletonKey?: string; startAfter?: number },
  ): Promise<string | null> {
    maybeFault(this.fault, "memory queue publish failed");
    this.published.push(event);
    return `job-${this.published.length}`;
  }
}

export class MemoryBodyCodec implements BodyCodec {
  encode(_ownerId: string, plaintext: string): Uint8Array {
    return Buffer.from(plaintext, "utf8");
  }

  decode(_ownerId: string, ciphertext: Uint8Array): string {
    return Buffer.from(ciphertext).toString("utf8");
  }
}

export class MemoryIngestRateLimiter implements IngestRateLimiter {
  fault: FaultSwitch = { throwInfra: false };
  allow = true;
  requestHits = 0;
  messageHits = 0;

  async checkRequestAllowed(_deviceId: string): Promise<RateLimitDecision> {
    maybeFault(this.fault, "memory ingest request rate limit failed");
    this.requestHits += 1;
    return {
      allowed: this.allow,
      limit: 60,
      remaining: this.allow ? 59 : 0,
      resetSec: 60,
      retryAfterSec: this.allow ? 0 : 60,
    };
  }

  async checkMessageVolumeAllowed(
    _deviceId: string,
    messageCount: number,
  ): Promise<RateLimitDecision> {
    maybeFault(this.fault, "memory ingest message rate limit failed");
    this.messageHits += messageCount;
    return {
      allowed: this.allow,
      limit: 10_000,
      remaining: this.allow ? 10_000 - messageCount : 0,
      resetSec: 3600,
      retryAfterSec: this.allow ? 0 : 3600,
    };
  }
}

export class MemoryMessageRepository implements MessageRepository {
  fault: FaultSwitch = { throwInfra: false };
  readonly rows = new Map<
    string,
    { id: string; ownerId: string; deviceId: string; message: MessageInsert }
  >();
  published: Array<{ ownerId: string; deviceId: string; messageId: string }> = [];
  lastSeenUpdates: string[] = [];
  private n = 0;

  async upsertBatch(input: {
    ownerId: string;
    deviceId: string;
    messages: MessageInsert[];
  }): Promise<MessageUpsertRow[]> {
    maybeFault(this.fault, "memory message upsert failed");
    const results: MessageUpsertRow[] = [];
    for (const msg of input.messages) {
      const key = `${input.deviceId}:${msg.deviceMsgId}`;
      const existing = this.rows.get(key);
      if (existing) {
        results.push({ deviceMsgId: msg.deviceMsgId, status: "duplicate", id: existing.id });
        continue;
      }
      this.n += 1;
      const id = `00000000-0000-4000-8000-${String(this.n).padStart(12, "0")}`;
      this.rows.set(key, { id, ownerId: input.ownerId, deviceId: input.deviceId, message: msg });
      this.published.push({
        ownerId: input.ownerId,
        deviceId: input.deviceId,
        messageId: id,
      });
      results.push({ deviceMsgId: msg.deviceMsgId, status: "accepted", id });
    }
    this.lastSeenUpdates.push(input.deviceId);
    return results;
  }

  async listRecent(ownerId: string, limit: number): Promise<MessageRecord[]> {
    maybeFault(this.fault, "memory message list recent failed");
    return [...this.rows.values()]
      .filter((r) => r.ownerId === ownerId)
      .map((r): MessageRecord => ({
        id: r.id,
        ownerId: r.ownerId,
        deviceId: r.deviceId,
        sender: r.message.sender,
        bodyCiphertext: r.message.bodyCiphertext,
        receivedAt: r.message.receivedAt,
        simSlot: r.message.simSlot,
        direction: r.message.direction,
      }))
      .sort((a, b) => {
        const t = b.receivedAt.getTime() - a.receivedAt.getTime();
        if (t !== 0) return t;
        return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
      })
      .slice(0, limit);
  }

  /** Test helper: seed a message without going through upsertBatch. */
  seed(record: MessageRecord): void {
    this.rows.set(`${record.deviceId}:seed-${record.id}`, {
      id: record.id,
      ownerId: record.ownerId,
      deviceId: record.deviceId,
      message: {
        deviceMsgId: `seed-${record.id}`,
        sender: record.sender,
        bodyCiphertext: record.bodyCiphertext,
        receivedAt: record.receivedAt,
        simSlot: record.simSlot,
        direction: record.direction,
      },
    });
  }
}

export class MemoryStreamRepository implements StreamRepository {
  fault: FaultSwitch = { throwInfra: false };
  readonly byId = new Map<string, Stream>();
  /** streamId → membership rows (test seeding for listMessages). */
  readonly memberships = new Map<string, StreamMessageRecord[]>();
  published: Array<{
    type: "stream.reclassify";
    owner_id: string;
    stream_id: string;
    version: number;
  }> = [];
  private n = 0;

  async insert(input: InsertStreamInput): Promise<Stream> {
    maybeFault(this.fault, "memory stream insert failed");
    this.n += 1;
    const now = new Date();
    const stream: Stream = {
      id: `00000000-0000-4000-8000-${String(this.n).padStart(12, "0")}`,
      ownerId: input.ownerId,
      name: input.name,
      mode: input.mode,
      rulesJson: input.rulesJson,
      aiPrompt: input.aiPrompt,
      version: 1,
      backfillStatus: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(stream.id, stream);
    return stream;
  }

  async list(ownerId: string, limit: number): Promise<Stream[]> {
    maybeFault(this.fault, "memory stream list failed");
    return [...this.byId.values()]
      .filter((s) => s.ownerId === ownerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async findById(ownerId: string, streamId: string): Promise<Stream | null> {
    maybeFault(this.fault, "memory stream lookup failed");
    const stream = this.byId.get(streamId);
    if (!stream || stream.ownerId !== ownerId) return null;
    return stream;
  }

  async update(input: {
    ownerId: string;
    streamId: string;
    patch: UpdateStreamPatch;
  }): Promise<Stream | null> {
    maybeFault(this.fault, "memory stream update failed");
    const current = await this.findById(input.ownerId, input.streamId);
    if (!current) return null;

    const nextName = input.patch.name ?? current.name;
    const nextMode = input.patch.mode ?? current.mode;
    const nextRules =
      input.patch.rulesJson !== undefined ? input.patch.rulesJson : current.rulesJson;
    const nextPrompt = input.patch.aiPrompt !== undefined ? input.patch.aiPrompt : current.aiPrompt;
    const definitionChanged =
      nextMode !== current.mode ||
      JSON.stringify(nextRules) !== JSON.stringify(current.rulesJson) ||
      nextPrompt !== current.aiPrompt;

    const updated: Stream = {
      ...current,
      name: nextName,
      mode: nextMode,
      rulesJson: nextRules,
      aiPrompt: nextPrompt,
      version: definitionChanged ? current.version + 1 : current.version,
      backfillStatus: definitionChanged ? "pending" : current.backfillStatus,
      updatedAt: new Date(),
    };
    this.byId.set(updated.id, updated);
    if (definitionChanged) {
      this.published.push({
        type: "stream.reclassify",
        owner_id: input.ownerId,
        stream_id: updated.id,
        version: updated.version,
      });
    }
    return updated;
  }

  async delete(ownerId: string, streamId: string): Promise<boolean> {
    maybeFault(this.fault, "memory stream delete failed");
    const current = await this.findById(ownerId, streamId);
    if (!current) return false;
    this.byId.delete(streamId);
    this.memberships.delete(streamId);
    return true;
  }

  async listMessages(input: ListStreamMessagesInput): Promise<ListStreamMessagesResult> {
    maybeFault(this.fault, "memory stream messages list failed");
    const stream = await this.findById(input.ownerId, input.streamId);
    if (!stream) return { messages: null };

    let rows = [...(this.memberships.get(input.streamId) ?? [])];
    rows.sort((a, b) => {
      const t = b.receivedAt.getTime() - a.receivedAt.getTime();
      if (t !== 0) return t;
      return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
    });
    if (input.cursor) {
      rows = rows.filter((r) => {
        const t = r.receivedAt.getTime() - input.cursor!.receivedAt.getTime();
        if (t < 0) return true;
        if (t > 0) return false;
        return r.id < input.cursor!.id;
      });
    }
    return { messages: rows.slice(0, input.limit) };
  }

  seedMembership(streamId: string, row: StreamMessageRecord): void {
    const list = this.memberships.get(streamId) ?? [];
    list.push(row);
    this.memberships.set(streamId, list);
  }
}
