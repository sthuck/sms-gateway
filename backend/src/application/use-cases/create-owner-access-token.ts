import {
  buildOwnerPatSecret,
  MAX_TOKEN_EXPIRES_IN_DAYS,
  MAX_TOKEN_NAME_LEN,
  type OwnerAccessToken,
} from "../../domain/auth/access-token.js";
import { TokenError } from "../../domain/auth/token-errors.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { AuditRepository } from "../../ports/outbound/audit-repository.js";
import type { IdGenerator } from "../../ports/outbound/id-generator.js";
import type { OwnerAccessTokenRepository } from "../../ports/outbound/owner-access-token-repository.js";
import type { TokenHasher } from "../../ports/outbound/token-hasher.js";

export type CreateOwnerAccessTokenInput = {
  ownerId: string;
  name: string;
  /**
   * Days until expiry. `null` / omitted → no expiry.
   * Must be an integer in 1..MAX_TOKEN_EXPIRES_IN_DAYS when set.
   */
  expiresInDays?: number | null;
  clientIp?: string | null;
  /** Injected for tests; defaults to Date.now(). */
  now?: Date;
};

export type CreateOwnerAccessTokenResult = {
  token: OwnerAccessToken;
  /** Full secret; returned once and never stored. */
  secret: string;
};

export type CreateOwnerAccessTokenDeps = {
  tokens: OwnerAccessTokenRepository;
  audit: AuditRepository;
  ids: IdGenerator;
  hasher: TokenHasher;
};

export class CreateOwnerAccessToken {
  constructor(private readonly deps: CreateOwnerAccessTokenDeps) {}

  async execute(input: CreateOwnerAccessTokenInput): Promise<CreateOwnerAccessTokenResult> {
    const name = validateTokenName(input.name);
    const now = input.now ?? new Date();
    const expiresAt = resolveExpiresAt(input.expiresInDays, now);
    const id = this.deps.ids.uuid();
    const secretPart = this.deps.ids.randomToken(32);
    const secret = buildOwnerPatSecret(id, secretPart);
    const tokenHash = this.deps.hasher.hash(secret);

    try {
      await this.deps.tokens.insert({
        id,
        ownerId: input.ownerId,
        name,
        tokenHash,
        expiresAt,
      });
      await this.deps.audit.append({
        ownerId: input.ownerId,
        actorType: "user",
        actorId: input.ownerId,
        action: "token.create",
        ip: input.clientIp ?? null,
      });
    } catch (err) {
      if (err instanceof TokenError) throw err;
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      throw InfrastructureError.wrap(err, "create owner access token failed");
    }

    return {
      token: {
        id,
        ownerId: input.ownerId,
        name,
        createdAt: now,
        lastUsedAt: null,
        expiresAt,
        revokedAt: null,
      },
      secret,
    };
  }
}

function validateTokenName(raw: unknown): string {
  if (typeof raw !== "string" || raw.includes("\u0000")) {
    throw new TokenError("invalid_request", 400, "Invalid token name");
  }
  const name = raw.trim();
  if (name.length < 1 || name.length > MAX_TOKEN_NAME_LEN) {
    throw new TokenError(
      "invalid_request",
      400,
      `name must be 1..${MAX_TOKEN_NAME_LEN} characters`,
    );
  }
  return name;
}

/**
 * `null` / `undefined` → no expiry.
 * Integer days → expires_at = now + days (must be in the future; max 366).
 */
export function resolveExpiresAt(expiresInDays: unknown, now: Date): Date | null {
  if (expiresInDays === undefined || expiresInDays === null) {
    return null;
  }
  if (
    typeof expiresInDays !== "number" ||
    !Number.isInteger(expiresInDays) ||
    expiresInDays < 1 ||
    expiresInDays > MAX_TOKEN_EXPIRES_IN_DAYS
  ) {
    throw new TokenError(
      "invalid_request",
      400,
      `expires_in_days must be an integer from 1 to ${MAX_TOKEN_EXPIRES_IN_DAYS}, or null`,
    );
  }
  const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000);
  if (!(expiresAt.getTime() > now.getTime())) {
    throw new TokenError("invalid_request", 400, "expires_at must be in the future");
  }
  return expiresAt;
}
