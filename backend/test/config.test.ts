import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults for local development", () => {
    const config = loadConfig({ NODE_ENV: "development" });
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.PORT).toBe(8080);
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("parses PORT as a number", () => {
    const config = loadConfig({ PORT: "9090" });
    expect(config.PORT).toBe(9090);
  });

  it("rejects invalid PORT", () => {
    expect(() => loadConfig({ PORT: "-1" })).toThrow(/Invalid configuration/);
  });
});
