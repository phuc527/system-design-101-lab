import { describe, expect, it } from "vitest";
import { createBackend, recordFailure, recordSuccess } from "../src/lb/backend.js";
import { HealthChecker, type HealthProbe } from "../src/lb/health-checker.js";

describe("backend health state machine", () => {
  it("goes DOWN only after `unhealthyThreshold` consecutive failures", () => {
    const b = createBackend("http://api1:3000");
    expect(recordFailure(b, 2, "boom")).toBeNull();
    expect(b.healthy).toBe(true);
    expect(recordFailure(b, 2, "boom")).toBe("went-down");
    expect(b.healthy).toBe(false);
    expect(b.lastError).toBe("boom");
  });

  it("a success in between resets the failure streak (no flapping)", () => {
    const b = createBackend("http://api1:3000");
    recordFailure(b, 2, "x");
    recordSuccess(b, 2);
    recordFailure(b, 2, "x");
    expect(b.healthy).toBe(true);
  });

  it("comes back UP only after `healthyThreshold` consecutive successes", () => {
    const b = createBackend("http://api1:3000");
    recordFailure(b, 1, "x");
    expect(b.healthy).toBe(false);
    expect(recordSuccess(b, 2)).toBeNull();
    expect(recordSuccess(b, 2)).toBe("went-up");
    expect(b.healthy).toBe(true);
  });
});

describe("HealthChecker (active checks)", () => {
  const options = { intervalMs: 1000, timeoutMs: 100, path: "/health", healthyThreshold: 2, unhealthyThreshold: 2 };

  it("marks a backend DOWN when /health returns non-2xx and UP again when it recovers", async () => {
    const backend = createBackend("http://api1:3000");
    let status = 503;
    const probedUrls: string[] = [];
    const probe: HealthProbe = async (url) => {
      probedUrls.push(url);
      return status;
    };
    const checker = new HealthChecker([backend], options, probe);

    await checker.checkAll();
    expect(backend.healthy).toBe(true); // 1 failure < threshold
    await checker.checkAll();
    expect(backend.healthy).toBe(false);
    expect(backend.lastError).toContain("503");
    expect(probedUrls[0]).toBe("http://api1:3000/health");

    status = 200;
    await checker.checkAll();
    expect(backend.healthy).toBe(false);
    await checker.checkAll();
    expect(backend.healthy).toBe(true);
  });

  it("treats network errors and timeouts as failures", async () => {
    const backend = createBackend("http://api2:3000");
    const probe: HealthProbe = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const checker = new HealthChecker([backend], options, probe);
    await checker.checkAll();
    await checker.checkAll();
    expect(backend.healthy).toBe(false);
    expect(backend.lastError).toContain("ECONNREFUSED");
  });
});
