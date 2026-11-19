import type { OwnerAccessToken } from "../../domain/auth/access-token.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { OwnerAccessTokenRepository } from "../../ports/outbound/owner-access-token-repository.js";

export type ListOwnerAccessTokensDeps = {
  tokens: OwnerAccessTokenRepository;
};

export class ListOwnerAccessTokens {
  constructor(private readonly deps: ListOwnerAccessTokensDeps) {}

  async execute(input: { ownerId: string }): Promise<OwnerAccessToken[]> {
    try {
      return await this.deps.tokens.list(input.ownerId);
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      throw InfrastructureError.wrap(err, "list owner access tokens failed");
    }
  }
}
