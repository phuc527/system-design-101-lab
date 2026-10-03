import { describe, expect, it } from "vitest";
import { createBackend, type Backend } from "../src/lb/backend.js";
import {
  createStrategy,
  fnv1a,
  IpHashStrategy,
  LeastConnectionsStrategy,
  RandomStrategy,
  RoundRobinStrategy,
} from "../src/lb/strategies.js";

const ctx = { clientIp: "1.2.3.4" };

function backends(n: number): Backend[] {
  return Array.from({ length: n }, (_, i) => createBackend(`http://api${i + 1}:3000`));
}

function ids(picks: Array<Backend | undefined>): string[] {
  return picks.map((b) => b?.id ?? "none");
}

describe("RoundRobinStrategy", () => {
  it("cycles through backends in order", () => {
    const rr = new RoundRobinStrategy();
    const pool = backends(3);
    const picks = Array.from({ length: 6 }, () => rr.pick(pool));
    expect(ids(picks)).toEqual(["api1:3000", "api2:3000", "api3:3000", "api1:3000", "api2:3000", "api3:3000"]);
  });

  it("returns undefined when there are no candidates", () => {
    expect(new RoundRobinStrategy().pick([])).toBeUndefined();
  });
});

describe("LeastConnectionsStrategy", () => {
  it("picks the backend with the fewest active connections", () => {
    const pool = backends(3);
    pool[0]!.activeConnections = 5;
    pool[1]!.activeConnections = 1;
    pool[2]!.activeConnections = 3;
    expect(new LeastConnectionsStrategy().pick(pool)?.id).toBe("api2:3000");
  });

  it("breaks ties round-robin instead of always picking the first", () => {
    const lc = new LeastConnectionsStrategy();
    const pool = backends(3); // all idle
    const picks = Array.from({ length: 3 }, () => lc.pick(pool));
    expect(new Set(ids(picks)).size).toBe(3);
  });
});

describe("IpHashStrategy", () => {
  it("always sends the same client IP to the same backend", () => {
    const ih = new IpHashStrategy();
    const pool = backends(3);
    const first = ih.pick(pool, ctx);
    for (let i = 0; i < 20; i++) expect(ih.pick(pool, ctx)).toBe(first);
  });

  it("spreads many different IPs over all backends", () => {
    const ih = new IpHashStrategy();
    const pool = backends(3);
    const counts = new Map<string, number>();
    for (let i = 0; i < 3000; i++) {
      const id = ih.pick(pool, { clientIp: `10.0.${Math.floor(i / 250)}.${i % 250}` })!.id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect(counts.size).toBe(3);
    for (const n of counts.values()) expect(n).toBeGreaterThan(700); // roughly 1000 each
  });

  it("remaps clients when the number of backends changes (why consistent hashing exists)", () => {
    const ih = new IpHashStrategy();
    const three = backends(3);
    const two = three.slice(0, 2);
    let moved = 0;
    for (let i = 0; i < 1000; i++) {
      const ip = `192.168.${Math.floor(i / 250)}.${i % 250}`;
      const before = ih.pick(three, { clientIp: ip });
      const after = ih.pick(two, { clientIp: ip });
      if (before !== after) moved++;
    }
    // Only clients on api3 (~33%) NEED to move; modulo hashing moves far more.
    expect(moved).toBeGreaterThan(450);
  });
});

describe("RandomStrategy", () => {
  it("uses the injected random source", () => {
    const pool = backends(4);
    expect(new RandomStrategy(() => 0).pick(pool)?.id).toBe("api1:3000");
    expect(new RandomStrategy(() => 0.99).pick(pool)?.id).toBe("api4:3000");
  });
});

describe("helpers", () => {
  it("createStrategy builds each strategy by name", () => {
    expect(createStrategy("round-robin").name).toBe("round-robin");
    expect(createStrategy("least-connections").name).toBe("least-connections");
    expect(createStrategy("ip-hash").name).toBe("ip-hash");
    expect(createStrategy("random").name).toBe("random");
  });

  it("fnv1a is deterministic", () => {
    expect(fnv1a("hello")).toBe(fnv1a("hello"));
    expect(fnv1a("hello")).not.toBe(fnv1a("hellp"));
  });
});
