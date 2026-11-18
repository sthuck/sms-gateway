import { describe, expect, it } from "vitest";
import { loadOidcAuthConfig } from "../../src/adapters/auth-oidc/oidc-config.js";

const secret = "dev-only-session-secret-min-32-chars!!";

describe("loadOidcAuthConfig", () => {
  it("returns null when issuer is unset", () => {
    expect(loadOidcAuthConfig({ NODE_ENV: "development" }, { nodeEnv: "development" })).toBeNull();
  });

  it("requires companion settings when issuer is set", () => {
    expect(() =>
      loadOidcAuthConfig({ OIDC_ISSUER_URL: "https://idp.example/" }, { nodeEnv: "development" }),
    ).toThrow(/missing required: OIDC_CLIENT_ID/);
  });

  it("loads a complete config with MFA defaults for production", () => {
    const config = loadOidcAuthConfig(
      {
        OIDC_ISSUER_URL: "https://idp.example/",
        OIDC_CLIENT_ID: "sms-gateway",
        OIDC_CLIENT_SECRET: "dev-only-client-secret",
        OIDC_REDIRECT_URI: "http://localhost:8080/v1/auth/callback",
        SESSION_SECRET: secret,
      },
      { nodeEnv: "production" },
    );

    expect(config).not.toBeNull();
    expect(config!.mfa.requireMfa).toBe(true);
    expect(config!.mfa.claimsMissing).toBe("deny");
    expect(config!.autoLinkByEmail).toBe(false);
    expect(config!.claimMapping).toEqual({ email: "email", name: "name" });
    expect(config!.audience).toBe("sms-gateway");
    expect(config!.allowedAlgs).toEqual(["RS256", "ES256"]);
  });

  it("defaults REQUIRE_MFA false outside production", () => {
    const config = loadOidcAuthConfig(
      {
        OIDC_ISSUER_URL: "https://idp.example/",
        OIDC_CLIENT_ID: "sms-gateway",
        OIDC_CLIENT_SECRET: "dev-only-client-secret",
        OIDC_REDIRECT_URI: "http://localhost:8080/v1/auth/callback",
        SESSION_SECRET: secret,
      },
      { nodeEnv: "development" },
    );
    expect(config!.mfa.requireMfa).toBe(false);
    expect(config!.mfa.claimsMissing).toBe("allow");
  });

  it("rejects OIDC_ALLOW_INSECURE in production", () => {
    expect(() =>
      loadOidcAuthConfig(
        {
          OIDC_ISSUER_URL: "https://idp.example/",
          OIDC_CLIENT_ID: "sms-gateway",
          OIDC_CLIENT_SECRET: "dev-only-client-secret",
          OIDC_REDIRECT_URI: "http://localhost:8080/v1/auth/callback",
          SESSION_SECRET: secret,
          OIDC_ALLOW_INSECURE: "true",
        },
        { nodeEnv: "production" },
      ),
    ).toThrow(/OIDC_ALLOW_INSECURE/);
  });

  it("honours claim mapping overrides", () => {
    const config = loadOidcAuthConfig(
      {
        OIDC_ISSUER_URL: "https://idp.example/",
        OIDC_CLIENT_ID: "sms-gateway",
        OIDC_CLIENT_SECRET: "dev-only-client-secret",
        OIDC_REDIRECT_URI: "http://localhost:8080/v1/auth/callback",
        SESSION_SECRET: secret,
        OIDC_CLAIM_EMAIL: "preferred_username",
        OIDC_CLAIM_NAME: "nickname",
        REQUIRE_MFA: "true",
        MFA_CLAIMS_MISSING: "deny",
      },
      { nodeEnv: "test" },
    );
    expect(config!.claimMapping.email).toBe("preferred_username");
    expect(config!.claimMapping.name).toBe("nickname");
    expect(config!.mfa.requireMfa).toBe(true);
  });
});
