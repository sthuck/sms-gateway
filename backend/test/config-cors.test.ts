import { describe, expect, it } from "vitest";
import { loadConfig, parseCorsAllowedOrigins } from "../src/config.js";

describe("CORS_ALLOWED_ORIGINS", () => {
  it("parses a comma-separated list", () => {
    expect(parseCorsAllowedOrigins("https://sms.sthuck.info, http://localhost:5173")).toEqual([
      "https://sms.sthuck.info",
      "http://localhost:5173",
    ]);
  });

  it("defaults to an empty list", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.corsAllowedOrigins).toEqual([]);
  });

  it("rejects invalid origin entries", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        CORS_ALLOWED_ORIGINS: "not-a-url",
      }),
    ).toThrow(/CORS_ALLOWED_ORIGINS/);
  });

  it("attaches origins to OIDC config when both are set", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CORS_ALLOWED_ORIGINS: "https://sms.sthuck.info",
      OIDC_ISSUER_URL: "https://auth.sthuck.info/application/o/sms-gateway/",
      OIDC_CLIENT_ID: "sms-gateway",
      OIDC_CLIENT_SECRET: "dev-only-client-secret",
      OIDC_REDIRECT_URI: "https://sms.sthuck.info/v1/auth/callback",
      SESSION_SECRET: "test-only-session-secret-32chars!!",
    });
    expect(config.corsAllowedOrigins).toEqual(["https://sms.sthuck.info"]);
    expect(config.oidc?.corsAllowedOrigins).toEqual(["https://sms.sthuck.info"]);
  });
});
