import { describe, expect, it } from "vitest";
import { ChaosService, parseChaosPatch } from "../src/services/chaos.service.js";

describe("ChaosService", () => {
  it("fails when random() is below the failure rate", () => {
    const values = [0.1, 0.5, 0.9];
    const chaos = new ChaosService({ failureRate: 0.5, extraLatencyMs: 0 }, () => values.shift() ?? 1);
    expect(chaos.shouldFail()).toBe(true);
    expect(chaos.shouldFail()).toBe(false);
    expect(chaos.shouldFail()).toBe(false);
  });

  it("update() and reset()", () => {
    const chaos = new ChaosService({ failureRate: 0, extraLatencyMs: 0 });
    expect(chaos.update({ failureRate: 0.3 })).toEqual({ failureRate: 0.3, extraLatencyMs: 0 });
    expect(chaos.reset()).toEqual({ failureRate: 0, extraLatencyMs: 0 });
  });
});

describe("parseChaosPatch", () => {
  it("accepts valid input", () => {
    expect(parseChaosPatch({ failureRate: 0.2 })).toEqual({ failureRate: 0.2 });
    expect(parseChaosPatch({ extraLatencyMs: 300, failureRate: 1 })).toEqual({ extraLatencyMs: 300, failureRate: 1 });
  });

  it("rejects invalid input with a message", () => {
    expect(typeof parseChaosPatch(null)).toBe("string");
    expect(typeof parseChaosPatch({})).toBe("string");
    expect(typeof parseChaosPatch({ failureRate: 2 })).toBe("string");
    expect(typeof parseChaosPatch({ failureRate: "0.5" })).toBe("string");
    expect(typeof parseChaosPatch({ extraLatencyMs: 1.5 })).toBe("string");
  });
});
