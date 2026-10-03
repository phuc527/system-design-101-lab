import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ChaosService } from "../services/chaos.service.js";
import { ChaosError } from "../utils/errors.js";
import { sleep } from "../utils/sleep.js";

/**
 * Injects latency and random failures into the routes it is mounted on.
 * Mounted only on /api/* so /health, /metrics and /chaos keep working
 * while you break the "business" endpoints.
 */
export function chaos(service: ChaosService): RequestHandler {
  return async (_req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const { extraLatencyMs } = service.get();
    if (extraLatencyMs > 0) await sleep(extraLatencyMs);
    if (service.shouldFail()) throw new ChaosError();
    next();
  };
}
