import { TokenError } from "../../domain/auth/token-errors.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { AuditRepository } from "../../ports/outbound/audit-repository.js";
import type { OwnerAccessTokenRepository } from "../../ports/outbound/owner-access-token-repository.js";

export type RevokeOwnerAccessTokenInput = {
  ownerId: string;
  tokenId: string;
  clientIp?: string | null;
};

export type RevokeOwnerAccessTokenDeps = {
  tokens: OwnerAccessTokenRepository;
  audit: AuditRepository;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RevokeOwnerAccessToken {
  constructor(private readonly deps: RevokeOwnerAccessTokenDeps) {}

  async execute(input: RevokeOwnerAccessTokenInput): Promise<void> {
    if (!UUID_RE.test(input.tokenId)) {
      throw new TokenError("not_found", 404, "Token not found");
    }

    try {
      const outcome = await this.deps.tokens.revoke(input.ownerId, input.tokenId);
      if (outcome === "missing") {
        throw new TokenError("not_found", 404, "Token not found");
      }
      if (outcome === "revoked") {
        await this.deps.audit.append({
          ownerId: input.ownerId,
          actorType: "user",
          actorId: input.ownerId,
          action: "token.revoke",
          ip: input.clientIp ?? null,
        });
      }
    } catch (err) {
      if (err instanceof TokenError) throw err;
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      throw InfrastructureError.wrap(err, "revoke owner access token failed");
    }
  }
}
