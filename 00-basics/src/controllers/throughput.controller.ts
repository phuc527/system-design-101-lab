import type { Request, Response } from "express";
import { fibonacci } from "../services/cpu.service.js";
import type { Services } from "../services/index.js";
import { intQuery } from "../utils/query.js";
import { sleep } from "../utils/sleep.js";

/**
 * THROUGHPUT = how many requests the server completes per second (RPS).
 *
 * Little's Law ties it to latency and concurrency:
 *     throughput = concurrency / latency
 *     100 in-flight requests / 0.1s each = 1000 RPS
 *
 * Node.js gets huge throughput on I/O-bound work (waiting is free) and
 * terrible throughput on CPU-bound work (one thread does all the math).
 */
export function createThroughputController({ config }: Services) {
  const meta = { instance: config.instanceName, pid: process.pid };

  return {
    /** GET /api/hello - does almost nothing. The ceiling for this server's RPS. */
    hello(_req: Request, res: Response): void {
      res.json({ ...meta, message: "hello" });
    },

    /**
     * GET /api/io?ms=100 - I/O-bound: waits without using CPU.
     * 1000 concurrent requests can all wait at the same time on one thread.
     */
    async io(req: Request, res: Response): Promise<void> {
      const ms = intQuery(req, "ms", 100, 0, 30_000);
      await sleep(ms);
      res.json({ ...meta, kind: "io-bound", waitedMs: ms });
    },

    /**
     * GET /api/cpu?n=30 - CPU-bound: computes fibonacci(n) synchronously.
     * While this runs, the event loop is BLOCKED: /health, /metrics and every
     * other request on this process wait until it finishes.
     */
    cpu(req: Request, res: Response): void {
      const n = intQuery(req, "n", 30, 1, config.limits.maxCpuN);
      const start = performance.now();
      const result = fibonacci(n);
      const serverMs = Math.round((performance.now() - start) * 100) / 100;
      res.json({ ...meta, kind: "cpu-bound", n, result, serverMs });
    },
  };
}
