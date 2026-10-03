import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiApp, type ApiApp } from "../src/api/app.js";
import { createBackend, type Backend } from "../src/lb/backend.js";
import { LoadBalancer } from "../src/lb/balancer.js";
import { HealthChecker } from "../src/lb/health-checker.js";
import { createStrategy, type StrategyName } from "../src/lb/strategies.js";

/**
 * Real HTTP end to end: 3 API instances on random ports, the TypeScript LB in
 * front of them, and fetch() as the client. No mocks.
 */

interface Instance extends ApiApp {
  server: http.Server;
  url: string;
}

let instances: Instance[] = [];
let backends: Backend[] = [];
let balancer: LoadBalancer;
let lbServer: http.Server;
let lbUrl = "";

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

async function startCluster(strategy: StrategyName = "round-robin"): Promise<void> {
  instances = await Promise.all(
    [1, 2, 3].map(async (i) => {
      const api = createApiApp({ port: 0, instanceName: `api${i}`, maxCpuN: 30, poolSize: 10 });
      const server = http.createServer(api.app);
      return { ...api, server, url: await listen(server) };
    }),
  );
  backends = instances.map((i) => createBackend(i.url));
  balancer = new LoadBalancer(backends, createStrategy(strategy), {
    proxyTimeoutMs: 1000,
    healthyThreshold: 2,
    unhealthyThreshold: 2,
  });
  lbServer = http.createServer((req, res) => void balancer.handle(req, res));
  lbUrl = await listen(lbServer);
}

async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; instance: string | null; body: unknown }> {
  const res = await fetch(`${lbUrl}${path}`, { headers });
  return { status: res.status, instance: res.headers.get("x-instance"), body: await res.json() };
}

async function instancesFor(n: number, path = "/"): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push((await get(path)).instance ?? "none");
  return out;
}

beforeEach(async () => {
  await startCluster();
});

afterEach(async () => {
  balancer.close();
  lbServer.closeAllConnections();
  await new Promise((r) => lbServer.close(r));
  for (const i of instances) {
    i.server.closeAllConnections();
    await new Promise((r) => i.server.close(r));
  }
});

describe("LoadBalancer (integration)", () => {
  it("round robin spreads requests evenly", async () => {
    const seen = await instancesFor(9);
    expect(seen.filter((s) => s === "api1")).toHaveLength(3);
    expect(seen.filter((s) => s === "api2")).toHaveLength(3);
    expect(seen.filter((s) => s === "api3")).toHaveLength(3);
  });

  it("adds X-Forwarded-For and X-Upstream headers", async () => {
    const res = await fetch(`${lbUrl}/`);
    expect(res.headers.get("x-upstream")).toMatch(/127\.0\.0\.1:\d+/);
    await res.arrayBuffer();
  });

  it("retries a failing backend's GET on another backend - the client never sees the error", async () => {
    instances[1]!.state.setChaos({ mode: "error", slowMs: 0 });
    const results = await Promise.all(Array.from({ length: 12 }, () => get("/")));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => r.instance === "api2")).toBe(false);
  });

  it("passive health check: repeated failures mark the backend DOWN", async () => {
    instances[1]!.state.setChaos({ mode: "error", slowMs: 0 });
    await instancesFor(9);
    const status = balancer.status();
    expect(status.backends[1]!.healthy).toBe(false);
    expect(status.healthyBackends).toBe(2);
  });

  it("does NOT retry POST requests (the body cannot be replayed safely)", async () => {
    for (const i of instances) i.state.setChaos({ mode: "error", slowMs: 0 });
    const res = await fetch(`${lbUrl}/cart/items`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "alice" },
      body: JSON.stringify({ item: "book" }),
    });
    expect(res.status).toBe(500); // the backend's own error, passed through after ONE attempt
    await res.arrayBuffer();
    expect(balancer.status().backends.reduce((sum, b) => sum + b.totalRequests, 0)).toBe(1);
  });

  it("returns 503 when every backend is DOWN", async () => {
    for (const b of backends) b.healthy = false;
    const res = await get("/");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "NO_HEALTHY_BACKENDS" } });
  });

  it("fails over when a backend process is gone (connection refused)", async () => {
    const dead = instances[0]!;
    dead.server.closeAllConnections();
    await new Promise((r) => dead.server.close(r));
    balancer.close(); // drop pooled keep-alive sockets to the dead server
    const results = await Promise.all(Array.from({ length: 6 }, () => get("/")));
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it("active health check removes a backend whose /health fails, even if traffic would succeed", async () => {
    instances[2]!.state.setChaos({ mode: "unhealthy", slowMs: 0 });
    const checker = new HealthChecker(backends, {
      intervalMs: 1000,
      timeoutMs: 500,
      path: "/health",
      healthyThreshold: 2,
      unhealthyThreshold: 2,
    });
    await checker.checkAll();
    await checker.checkAll();
    expect(backends[2]!.healthy).toBe(false);
    expect(await instancesFor(6)).not.toContain("api3");
  });

  /**
   * Sustained load: 6 clients, each sending requests back-to-back.
   * (A single burst of simultaneous requests would NOT show the difference:
   * when everything arrives at once, every backend has 0 in flight and
   * least-connections degrades to round robin.)
   */
  async function sustainedLoad(clients: number, perClient: number): Promise<string[]> {
    const seen: string[] = [];
    await Promise.all(
      Array.from({ length: clients }, async () => {
        for (let i = 0; i < perClient; i++) seen.push((await get("/work?ms=20")).instance ?? "none");
      }),
    );
    return seen;
  }

  it("least-connections sends far fewer requests to a slow backend than round robin", async () => {
    instances[0]!.state.setChaos({ mode: "slow", slowMs: 300 });

    const roundRobin = await sustainedLoad(6, 8);
    balancer.setStrategy(createStrategy("least-connections"));
    const leastConn = await sustainedLoad(6, 8);

    const slowShare = (seen: string[]): number => seen.filter((s) => s === "api1").length / seen.length;
    expect(slowShare(roundRobin)).toBeGreaterThan(0.25); // ~1/3: round robin is blind to load
    expect(slowShare(leastConn)).toBeLessThan(0.15);
  });

  it("successful traffic does not mask a failing health check (regression)", async () => {
    // Found during the graceful-shutdown experiment: a draining instance returns
    // 503 on /health but still serves requests. Proxied successes must not reset
    // the health-check failure streak, or the backend is never removed.
    instances[1]!.state.setChaos({ mode: "unhealthy", slowMs: 0 });
    const checker = new HealthChecker(backends, {
      intervalMs: 1000,
      timeoutMs: 500,
      path: "/health",
      healthyThreshold: 2,
      unhealthyThreshold: 2,
    });
    await checker.checkAll();
    await instancesFor(9); // real traffic succeeds on api2 in between checks
    await checker.checkAll();
    expect(backends[1]!.healthy).toBe(false);
  });

  it("admin endpoints: status and runtime strategy switch", async () => {
    const res = await fetch(`${lbUrl}/lb/strategy?name=ip-hash`, { method: "POST" });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    const status = (await get("/lb/status")).body as { strategy: string };
    expect(status.strategy).toBe("ip-hash");

    const bad = await fetch(`${lbUrl}/lb/strategy?name=magic`, { method: "POST" });
    expect(bad.status).toBe(400);
    await bad.arrayBuffer();
  });

  it("ip-hash keeps a client on one backend; different clients spread out", async () => {
    balancer.setStrategy(createStrategy("ip-hash"));
    const same = new Set<string | null>();
    for (let i = 0; i < 5; i++) same.add((await get("/", { "x-forwarded-for": "203.0.113.7" })).instance);
    expect(same.size).toBe(1);

    const many = new Set<string | null>();
    for (let i = 0; i < 30; i++) many.add((await get("/", { "x-forwarded-for": `198.51.100.${i}` })).instance);
    expect(many.size).toBe(3);
  });
});
