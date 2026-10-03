import type { Request, Response } from "express";
import type { Services } from "../services/index.js";
import { floatQuery, intQuery } from "../utils/query.js";
import { sleep } from "../utils/sleep.js";

/**
 * LATENCY = how long ONE request takes, from start to finish.
 *
 * `sleep(ms)` stands in for real I/O: a database query, a call to another
 * service, reading a file. We do not burn CPU while waiting.
 */
export function createLatencyController({ config }: Services) {
  const meta = { instance: config.instanceName, pid: process.pid };

  return {
    /**
     * GET /api/latency?ms=100&tailRate=0.05&tailMs=1000
     * Most requests take `ms`; a fraction `tailRate` take `tailMs` instead.
     * This produces a realistic "long tail" so you can see p50 vs p99 diverge.
     */
    async single(req: Request, res: Response): Promise<void> {
      const ms = intQuery(req, "ms", 100, 0, 30_000);
      const tailRate = floatQuery(req, "tailRate", 0, 0, 1);
      const tailMs = intQuery(req, "tailMs", 1000, 0, 30_000);

      const isTail = Math.random() < tailRate;
      const delay = isTail ? tailMs : ms;
      const start = performance.now();
      await sleep(delay);

      res.json({ ...meta, requestedMs: delay, slowRequest: isTail, serverMs: round(performance.now() - start) });
    },

    /**
     * GET /api/latency/sequential?calls=3&ms=100
     * Calls run one after another: total latency = SUM of calls (~300ms).
     */
    async sequential(req: Request, res: Response): Promise<void> {
      const calls = intQuery(req, "calls", 3, 1, 50);
      const ms = intQuery(req, "ms", 100, 0, 5_000);
      const start = performance.now();
      for (let i = 0; i < calls; i++) {
        await sleep(ms);
      }
      res.json({ ...meta, strategy: "sequential", calls, msPerCall: ms, serverMs: round(performance.now() - start) });
    },

    /**
     * GET /api/latency/parallel?calls=3&ms=100
     * Independent calls run concurrently with Promise.all:
     * total latency = SLOWEST call (~100ms), not the sum.
     */
    async parallel(req: Request, res: Response): Promise<void> {
      const calls = intQuery(req, "calls", 3, 1, 50);
      const ms = intQuery(req, "ms", 100, 0, 5_000);
      const start = performance.now();
      await Promise.all(Array.from({ length: calls }, () => sleep(ms)));
      res.json({ ...meta, strategy: "parallel", calls, msPerCall: ms, serverMs: round(performance.now() - start) });
    },
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
