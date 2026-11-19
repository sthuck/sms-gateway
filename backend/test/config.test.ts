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
});
