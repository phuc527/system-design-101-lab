import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/api/app.js";
import type { ApiConfig } from "../src/api/config.js";

const config: ApiConfig = { port: 0, instanceName: "test-api", maxCpuN: 30, poolSize: 10 };

describe("API instance", () => {
  it("GET / identifies the instance and counts requests", async () => {
    const { app } = createApiApp(config);
    const first = await request(app).get("/").expect(200);
    const second = await request(app).get("/").expect(200);
    expect(first.body.instance).toBe("test-api");
    expect(first.headers["x-instance"]).toBe("test-api");
    expect(second.body.requestNumber).toBe(first.body.requestNumber + 1);
  });

  it("GET /cpu and /work validate input", async () => {
    const { app } = createApiApp(config);
    expect((await request(app).get("/cpu?n=20").expect(200)).body.result).toBe(6765);
    await request(app).get("/cpu?n=99").expect(400);
    await request(app).get("/work?ms=-1").expect(400);
    await request(app).get("/work?ms=5").expect(200);
  });

  it("tracks in-flight requests", async () => {
    const { app, state } = createApiApp(config);
    const pending = request(app).get("/work?ms=150");
    const done = pending.then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    expect(state.stats().inFlight).toBe(1);
    await done;
    expect(state.stats().inFlight).toBe(0);
  });

  describe("chaos modes", () => {
    it("error: everything (including /health) returns 500, /admin still works", async () => {
      const { app } = createApiApp(config);
      await request(app).post("/admin/chaos").send({ mode: "error" }).expect(200);
      await request(app).get("/").expect(500);
      await request(app).get("/health").expect(500);
      await request(app).get("/admin/stats").expect(200);
    });

    it("unhealthy: only /health fails, real traffic still works", async () => {
      const { app } = createApiApp(config);
      await request(app).post("/admin/chaos").send({ mode: "unhealthy" }).expect(200);
      await request(app).get("/health").expect(503);
      await request(app).get("/").expect(200);
    });

    it("slow: delays requests by slowMs", async () => {
      const { app } = createApiApp(config);
      await request(app).post("/admin/chaos").send({ mode: "slow", slowMs: 120 }).expect(200);
      const start = Date.now();
      await request(app).get("/").expect(200);
      expect(Date.now() - start).toBeGreaterThanOrEqual(110);
    });

    it("rejects invalid chaos settings", async () => {
      const { app } = createApiApp(config);
      await request(app).post("/admin/chaos").send({ mode: "explode" }).expect(400);
      await request(app).post("/admin/chaos").send({ mode: "slow", slowMs: -5 }).expect(400);
    });
  });

  it("/health returns 503 while shutting down (connection draining)", async () => {
    let shuttingDown = false;
    const { app } = createApiApp(config, () => shuttingDown);
    await request(app).get("/health").expect(200);
    shuttingDown = true;
    const res = await request(app).get("/health").expect(503);
    expect(res.body.reason).toBe("shutting down");

    // Keep-alive clients (load balancers) are told to reconnect elsewhere.
    const traffic = await request(app).get("/").expect(200);
    expect(traffic.headers["connection"]).toBe("close");
  });

  it("stores carts in memory per user", async () => {
    const { app } = createApiApp(config);
    await request(app).post("/cart/items").set("X-User-Id", "alice").send({ item: "keyboard" }).expect(201);
    await request(app).post("/cart/items").set("X-User-Id", "alice").send({ item: "mouse" }).expect(201);
    const res = await request(app).get("/cart").set("X-User-Id", "alice").expect(200);
    expect(res.body.items).toEqual(["keyboard", "mouse"]);
    await request(app).get("/cart").expect(400); // header required
  });
});
