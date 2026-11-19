import {
  parseOwnerPatTokenId,
  type OwnerAccessTokenLookup,
} from "../../domain/auth/access-token.js";
import { AuthError } from "../../domain/auth/errors.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { OwnerAccessTokenRepository } from "../../ports/outbound/owner-access-token-repository.js";
import type { TokenHasher } from "../../ports/outbound/token-hasher.js";

export type ResolveOwnerPatInput = {
  token: string;
};

export type ResolveOwnerPatResult = {
  ownerId: string;
  tokenId: string;
  lastUsedAt: Date | null;
};

export type ResolveOwnerPatDeps = {
  tokens: OwnerAccessTokenRepository;
  hasher: TokenHasher;
};

/** Fixed-length dummy hash so missing rows still run a constant-time compare. */
const DUMMY_HASH_HEX = "0".repeat(64);

export class ResolveOwnerPat {
  constructor(private readonly deps: ResolveOwnerPatDeps) {}

  async execute(input: ResolveOwnerPatInput): Promise<ResolveOwnerPatResult> {
    const tokenId = parseOwnerPatTokenId(input.token);
    const presentedHash = this.deps.hasher.hash(input.token);

    let row: OwnerAccessTokenLookup | null = null;
    if (tokenId) {
      try {
        row = await this.deps.tokens.lookupById(tokenId);
      } catch (err) {
        if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
        throw InfrastructureError.wrap(err, "resolve owner PAT failed");
      }
    }

    const expectedHex = row?.tokenHash ?? DUMMY_HASH_HEX;
    const ok = this.deps.hasher.safeEqual(presentedHash, expectedHex);
    if (!ok || !row || row.revokedAt != null) {
      throw new AuthError("unauthorized", "Missing or invalid access token");
    }

    return {
      ownerId: row.ownerId,
      tokenId: row.id,
      lastUsedAt: row.lastUsedAt,
    };
  }
}
