import { afterEach, describe, expect, it } from "vitest";
import { loadLbConfig } from "../src/lb/config.js";
import { ConfigError } from "../src/shared/env.js";

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe("loadLbConfig", () => {
  it("parses a valid configuration", () => {
    process.env["BACKENDS"] = "http://api1:3000, http://api2:3000";
    process.env["LB_STRATEGY"] = "least-connections";
    const config = loadLbConfig();
    expect(config.backends).toEqual(["http://api1:3000", "http://api2:3000"]);
    expect(config.strategy).toBe("least-connections");
    expect(config.port).toBe(8091);
  });

  it("rejects backend URLs without http:// (new URL('api1:3000') would silently accept them)", () => {
    process.env["BACKENDS"] = "api1:3000";
    expect(() => loadLbConfig()).toThrow(ConfigError);
  });

  it("rejects unknown strategies and out-of-range numbers", () => {
    process.env["LB_STRATEGY"] = "fastest";
    expect(() => loadLbConfig()).toThrow(/LB_STRATEGY/);
    process.env["LB_STRATEGY"] = "round-robin";
    process.env["UNHEALTHY_THRESHOLD"] = "0";
    expect(() => loadLbConfig()).toThrow(/UNHEALTHY_THRESHOLD/);
  });
});
