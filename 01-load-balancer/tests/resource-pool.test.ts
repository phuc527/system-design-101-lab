import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/api/app.js";
import { ResourcePool } from "../src/api/services/resource-pool.js";

describe("ResourcePool", () => {
  it("hands out up to `size` slots, then queues", async () => {
    const pool = new ResourcePool(2);
    const r1 = await pool.acquire();
    await pool.acquire();
    expect(pool.stats()).toEqual({ size: 2, active: 2, waiting: 0 });

    let thirdGotSlot = false;
    const third = pool.acquire().then((release) => {
      thirdGotSlot = true;
      return release;
    });
    await Promise.resolve();
    expect(thirdGotSlot).toBe(false);
    expect(pool.stats().waiting).toBe(1);

    r1(); // free a slot -> handed directly to the waiter
    const r3 = await third;
    expect(thirdGotSlot).toBe(true);
    expect(pool.stats()).toEqual({ size: 2, active: 2, waiting: 0 });

    r3();
    r3(); // releasing twice must not corrupt the count
    expect(pool.stats().active).toBe(1);
  });

  it("caps one instance's throughput: 6 requests on a pool of 2 take 3 rounds", async () => {
    const { app } = createApiApp({ port: 0, instanceName: "t", maxCpuN: 30, poolSize: 2 });
    const start = Date.now();
    const results = await Promise.all(Array.from({ length: 6 }, () => request(app).get("/work?ms=100")));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(280); // 3 rounds x 100ms
    expect(Math.max(...results.map((r) => r.body.queuedMs as number))).toBeGreaterThanOrEqual(180);
  });
});
