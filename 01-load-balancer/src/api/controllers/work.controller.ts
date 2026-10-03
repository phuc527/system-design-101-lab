import os from "node:os";
import type { Request, Response } from "express";
import type { ApiConfig } from "../config.js";
import { BadRequestError } from "../errors.js";
import { fibonacci } from "../services/cpu.js";
import type { InstanceState } from "../services/instance-state.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function intQuery(req: Request, name: string, fallback: number, min: number, max: number): number {
  const raw = req.query[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (typeof raw !== "string" || !Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestError(`"${name}" must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** The "business" endpoints the load balancer spreads across instances. */
export function createWorkController(config: ApiConfig, state: InstanceState) {
  const identity = (res: Response) => ({
    instance: config.instanceName,
    hostname: os.hostname(),
    pid: process.pid,
    requestNumber: res.locals["requestNumber"] as number,
    inFlight: state.stats().inFlight,
  });

  return {
    /** GET / - who am I? Call it repeatedly through the LB to see the distribution. */
    whoami(_req: Request, res: Response): void {
      res.json({ ...identity(res), time: new Date().toISOString() });
    },

    /**
     * GET /work?ms=100 - simulates a database query: grab a connection from
     * this instance's pool (POOL_SIZE, default 10), hold it for `ms`, release.
     *
     * Capacity per instance = POOL_SIZE / query time = 10 / 0.1s = 100 req/s.
     * Above that, requests queue for a connection (see queuedMs) - adding
     * instances behind the load balancer adds pools, so capacity grows.
     */
    async work(req: Request, res: Response): Promise<void> {
      const ms = intQuery(req, "ms", 100, 0, 30_000);
      const waitStart = performance.now();
      const release = await state.pool.acquire();
      const queuedMs = Math.round(performance.now() - waitStart);
      try {
        await sleep(ms);
      } finally {
        release();
      }
      res.json({ ...identity(res), kind: "io", queryMs: ms, queuedMs, pool: state.pool.stats() });
    },

    /**
     * GET /cpu?n=30 - CPU-bound: one instance = one CPU's worth of throughput.
     * This is where adding instances behind the LB increases RPS.
     */
    cpu(req: Request, res: Response): void {
      const n = intQuery(req, "n", 30, 1, config.maxCpuN);
      const start = performance.now();
      const result = fibonacci(n);
      res.json({ ...identity(res), kind: "cpu", n, result, serverMs: Math.round(performance.now() - start) });
    },
  };
}
