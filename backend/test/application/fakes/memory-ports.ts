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
