import { AuthError } from "../../domain/auth/errors.js";
import type { GetMeInput, GetMeResult } from "../../ports/inbound/auth.js";
import type { UserRepository } from "../../ports/outbound/user-repository.js";

export type GetMeDeps = {
  users: UserRepository;
};

export class GetMe {
  constructor(private readonly deps: GetMeDeps) {}

  async execute(input: GetMeInput): Promise<GetMeResult> {
    const user = await this.deps.users.findById(input.ownerId, input.ownerId);
    if (!user) {
      throw new AuthError("unauthorized", "User not found");
    }
    return {
      ...user,
      authMethod: input.authMethod,
    };
  }
}
