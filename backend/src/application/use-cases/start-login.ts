import type { StartLoginResult } from "../../ports/inbound/auth.js";
import type { OidcProvider } from "../../ports/outbound/oidc-provider.js";

export type StartLoginDeps = {
  oidc: OidcProvider;
};

export class StartLogin {
  constructor(private readonly deps: StartLoginDeps) {}

  async execute(): Promise<StartLoginResult> {
    return this.deps.oidc.startAuthorization();
  }
}
