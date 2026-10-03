import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/index.js";
import { createServices, type Services } from "../src/services/index.js";

describe("HTTP API", () => {
  let services: Services;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    services = createServices(loadConfig());
    app = createApp(services);
  });

  afterEach(() => {
    services.runtime.stop();
  });

  it("GET /health", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(res.body.status).toBe("ok");
    expect(res.headers["x-instance"]).toMatch(/\/\d+$/);
  });

  it("validates query parameters", async () => {
    const res = await request(app).get("/api/latency?ms=abc").expect(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
  });

  it("sequential calls add up, parallel calls overlap", async () => {
    const seq = await request(app).get("/api/latency/sequential?calls=3&ms=50").expect(200);
    const par = await request(app).get("/api/latency/parallel?calls=3&ms=50").expect(200);
    expect(seq.body.serverMs).toBeGreaterThanOrEqual(145);
    expect(par.body.serverMs).toBeLessThan(140);
  });

  it("GET /api/cpu computes fibonacci", async () => {
    const res = await request(app).get("/api/cpu?n=20").expect(200);
    expect(res.body.result).toBe(6765);
  });

  it("compresses large payloads when the client accepts gzip", async () => {
    const plain = await request(app).get("/api/payload?kb=50").set("Accept-Encoding", "identity").expect(200);
    const gzip = await request(app).get("/api/payload?kb=50").set("Accept-Encoding", "gzip").expect(200);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(Number(plain.headers["content-length"])).toBeGreaterThanOrEqual(50 * 1024);
  });

  it("streams a throttled download at roughly the requested speed", async () => {
    const start = Date.now();
    const res = await request(app).get("/api/download?kb=10&kbps=20").buffer(true).expect(200);
    const seconds = (Date.now() - start) / 1000;
    expect(res.headers["content-length"]).toBe(String(10 * 1024));
    expect(seconds).toBeGreaterThanOrEqual(0.4); // 10 KB / 20 KB/s = 0.5s
  });

  describe("chaos", () => {
    it("failureRate=1 breaks /api/* but not /health", async () => {
      await request(app).post("/chaos").send({ failureRate: 1 }).expect(200);

      const broken = await request(app).get("/api/hello").expect(500);
      expect(broken.body.error.code).toBe("CHAOS_INJECTED_FAILURE");
      await request(app).get("/health").expect(200);

      const metrics = await request(app).get("/metrics").expect(200);
      expect(metrics.body.requests.routes["GET /api/hello"].errors).toBe(1);
    });

    it("rejects invalid chaos settings", async () => {
      await request(app).post("/chaos").send({ failureRate: 5 }).expect(400);
    });

    it("rejects malformed JSON", async () => {
      const res = await request(app).post("/chaos").set("Content-Type", "application/json").send("{oops").expect(400);
      expect(res.body.error.code).toBe("INVALID_JSON");
    });
  });

  it("GET /availability", async () => {
    const res = await request(app).get("/availability?percent=99&replicas=2&dependencies=2").expect(200);
    expect(res.body.parallel.availabilityPercent).toBe(99.99);
  });

  it("CAP simulator over HTTP: AP mode keeps serving stale data during a partition", async () => {
    await request(app).post("/cap/mode").send({ mode: "AP" }).expect(200);
    await request(app).put("/cap/nodes/A/keys/stock").send({ value: "10" }).expect(200);
    await request(app).post("/cap/partition").expect(200);
    await request(app).put("/cap/nodes/A/keys/stock").send({ value: "9" }).expect(200);

    const stale = await request(app).get("/cap/nodes/B/keys/stock").expect(200);
    expect(stale.body.value).toBe("10");

    await request(app).post("/cap/mode").send({ mode: "CP" }).expect(200);
    await request(app).get("/cap/nodes/B/keys/stock").expect(503);

    const healed = await request(app).post("/cap/heal").expect(200);
    expect(healed.body.state.nodes.B.stock.value).toBe("9");
  });

  it("returns 404 JSON for unknown routes", async () => {
    const res = await request(app).get("/nope").expect(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
