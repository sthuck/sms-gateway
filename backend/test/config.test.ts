import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults for local development", () => {
    const config = loadConfig({ NODE_ENV: "development" });
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.PORT).toBe(8080);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.encryption.enabled).toBe(false);
    expect(config.webDistDir).toBeNull();
  });

  it("parses and trims WEB_DIST_DIR", () => {
    expect(loadConfig({ WEB_DIST_DIR: "   " }).webDistDir).toBeNull();
    expect(loadConfig({ WEB_DIST_DIR: "  /app/web-dist  " }).webDistDir).toBe("/app/web-dist");
  });

  it("requires KEK_FILE when encryption is enabled", () => {
    expect(() => loadConfig({ NODE_ENV: "development", ENCRYPTION_ENABLED: "true" })).toThrow(
      /KEK_FILE/,
    );
  });

  it("parses PORT as a number", () => {
    const config = loadConfig({ PORT: "9090" });
    expect(config.PORT).toBe(9090);
  });

  it("rejects invalid PORT", () => {
    expect(() => loadConfig({ PORT: "-1" })).toThrow(/Invalid configuration/);
  });

  describe("clientAccess Cloudflare Access config", () => {
    it("defaults both deviceHeaders and agentHeaders to null", () => {
      const config = loadConfig({ NODE_ENV: "development" });
      expect(config.clientAccess).toEqual({
        deviceHeaders: null,
        agentHeaders: null,
      });
    });

    it("uses shared CF_ACCESS_* for both device and agent when overrides are unset", () => {
      const config = loadConfig({
        NODE_ENV: "development",
        CF_ACCESS_CLIENT_ID: "shared-id",
        CF_ACCESS_CLIENT_SECRET: "shared-secret",
      });
      expect(config.clientAccess).toEqual({
        deviceHeaders: {
          "CF-Access-Client-Id": "shared-id",
          "CF-Access-Client-Secret": "shared-secret",
        },
        agentHeaders: {
          "CF-Access-Client-Id": "shared-id",
          "CF-Access-Client-Secret": "shared-secret",
        },
      });
    });

    it("applies scoped overrides over shared and allows enabling one client type only", () => {
      const deviceOnly = loadConfig({
        NODE_ENV: "development",
        DEVICE_CF_ACCESS_CLIENT_ID: "dev-id",
        DEVICE_CF_ACCESS_CLIENT_SECRET: "dev-sec",
      });
      expect(deviceOnly.clientAccess).toEqual({
        deviceHeaders: {
          "CF-Access-Client-Id": "dev-id",
          "CF-Access-Client-Secret": "dev-sec",
        },
        agentHeaders: null,
      });

      const agentOnly = loadConfig({
        NODE_ENV: "development",
        AGENT_CF_ACCESS_CLIENT_ID: "agent-id",
        AGENT_CF_ACCESS_CLIENT_SECRET: "agent-sec",
      });
      expect(agentOnly.clientAccess).toEqual({
        deviceHeaders: null,
        agentHeaders: {
          "CF-Access-Client-Id": "agent-id",
          "CF-Access-Client-Secret": "agent-sec",
        },
      });

      const overridden = loadConfig({
        NODE_ENV: "development",
        CF_ACCESS_CLIENT_ID: "shared-id",
        CF_ACCESS_CLIENT_SECRET: "shared-sec",
        DEVICE_CF_ACCESS_CLIENT_ID: "dev-id",
        DEVICE_CF_ACCESS_CLIENT_SECRET: "dev-sec",
      });
      expect(overridden.clientAccess).toEqual({
        deviceHeaders: {
          "CF-Access-Client-Id": "dev-id",
          "CF-Access-Client-Secret": "dev-sec",
        },
        agentHeaders: {
          "CF-Access-Client-Id": "shared-id",
          "CF-Access-Client-Secret": "shared-sec",
        },
      });
    });

    it("fails fast when only one half of any CF Access pair is set", () => {
      expect(() => loadConfig({ CF_ACCESS_CLIENT_ID: "id-only" })).toThrow(
        /CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET/,
      );
      expect(() => loadConfig({ CF_ACCESS_CLIENT_SECRET: "secret-only" })).toThrow(
        /CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET/,
      );
      expect(() => loadConfig({ DEVICE_CF_ACCESS_CLIENT_ID: "id-only" })).toThrow(
        /DEVICE_CF_ACCESS_CLIENT_ID and DEVICE_CF_ACCESS_CLIENT_SECRET/,
      );
      expect(() => loadConfig({ DEVICE_CF_ACCESS_CLIENT_SECRET: "secret-only" })).toThrow(
        /DEVICE_CF_ACCESS_CLIENT_ID and DEVICE_CF_ACCESS_CLIENT_SECRET/,
      );
      expect(() => loadConfig({ AGENT_CF_ACCESS_CLIENT_ID: "id-only" })).toThrow(
        /AGENT_CF_ACCESS_CLIENT_ID and AGENT_CF_ACCESS_CLIENT_SECRET/,
      );
      expect(() => loadConfig({ AGENT_CF_ACCESS_CLIENT_SECRET: "secret-only" })).toThrow(
        /AGENT_CF_ACCESS_CLIENT_ID and AGENT_CF_ACCESS_CLIENT_SECRET/,
      );
    });

    it("fails fast on invalid header values (control chars or outer whitespace)", () => {
      expect(() =>
        loadConfig({
          CF_ACCESS_CLIENT_ID: " id-with-space",
          CF_ACCESS_CLIENT_SECRET: "valid-secret",
        }),
      ).toThrow(/Invalid configuration/);
      expect(() =>
        loadConfig({
          CF_ACCESS_CLIENT_ID: "valid-id",
          CF_ACCESS_CLIENT_SECRET: "bad\nsecret",
        }),
      ).toThrow(/Invalid configuration/);
    });
  });
});
