import { describe, expect, it } from "vitest";
import { percentile, StatsService, summarize } from "../src/services/stats.service.js";

describe("percentile (nearest rank)", () => {
  const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it("returns the value below which p% of samples fall", () => {
    expect(percentile(oneToHundred, 50)).toBe(50);
    expect(percentile(oneToHundred, 95)).toBe(95);
    expect(percentile(oneToHundred, 99)).toBe(99);
    expect(percentile(oneToHundred, 100)).toBe(100);
  });

  it("returns 0 for no samples", () => {
    expect(percentile([], 99)).toBe(0);
  });
});

describe("summarize", () => {
  it("shows how one slow request hides in the average but not in p99", () => {
    const samples = [...Array<number>(99).fill(10), 5000];
    const s = summarize(samples);
    expect(s.p50).toBe(10);
    expect(s.avg).toBeCloseTo(59.9, 1); // "looks fine"
    expect(s.p99).toBe(10);
    expect(s.max).toBe(5000);

    // With 2% slow requests the p99 exposes them
    const twoPercentSlow = summarize([...Array<number>(98).fill(10), 5000, 5000]);
    expect(twoPercentSlow.p99).toBe(5000);
  });
});

describe("StatsService", () => {
  it("counts requests, 5xx errors and availability", () => {
    const stats = new StatsService();
    stats.record("GET /a", 10, 200);
    stats.record("GET /a", 20, 404); // client error: not counted against availability
    stats.record("GET /a", 30, 500);
    stats.record("GET /b", 40, 503);

    const snap = stats.snapshot();
    expect(snap.totalRequests).toBe(4);
    expect(snap.totalErrors).toBe(2);
    expect(snap.errorRate).toBe(0.5);
    expect(snap.availabilityPercent).toBe(50);
    expect(snap.routes["GET /a"]).toEqual({ count: 3, errors: 1, avgMs: 20 });
  });

  it("keeps a bounded window of latency samples (ring buffer)", () => {
    const stats = new StatsService(5);
    for (let i = 1; i <= 12; i++) stats.record("GET /", i, 200);
    const snap = stats.snapshot();
    expect(snap.latencyMs.samples).toBe(5);
    expect(snap.latencyMs.min).toBe(8);
    expect(snap.latencyMs.max).toBe(12);
  });

  it("computes RPS over completed seconds only", () => {
    let now = 1_000_000_000;
    const stats = new StatsService(1000, 10, () => now);

    // 50 requests in each of 10 consecutive seconds
    for (let s = 0; s < 10; s++) {
      for (let i = 0; i < 50; i++) stats.record("GET /", 1, 200);
      now += 1000;
    }
    // A partial current second must not change the result
    for (let i = 0; i < 7; i++) stats.record("GET /", 1, 200);

    expect(stats.snapshot().rps).toBe(50);
  });

  it("reset() clears everything", () => {
    const stats = new StatsService();
    stats.record("GET /", 5, 500);
    stats.reset();
    const snap = stats.snapshot();
    expect(snap.totalRequests).toBe(0);
    expect(snap.latencyMs.samples).toBe(0);
    expect(snap.routes).toEqual({});
  });
});
