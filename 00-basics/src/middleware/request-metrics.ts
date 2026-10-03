import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { StatsService } from "../services/stats.service.js";

/**
 * Measures server-side latency for every request and feeds StatsService.
 *
 * This is the time between "request arrived at Node" and "response finished".
 * It does NOT include network time - the client always sees a higher number.
 * Compare the two in the experiments: client latency - server latency = network + queueing.
 */
export function requestMetrics(stats: StatsService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      // Use the route *pattern* ("/api/latency") not the raw URL ("/api/latency?ms=7")
      // so metrics are grouped instead of creating one entry per unique URL.
      const mountPath: unknown = res.locals[MOUNT_PATH_KEY];
      const prefix = typeof mountPath === "string" ? mountPath : req.baseUrl;
      const routePath = req.route ? `${prefix}${String(req.route.path)}` : "unmatched";
      stats.record(`${req.method} ${routePath}`, durationMs, res.statusCode);
    });

    next();
  };
}

const MOUNT_PATH_KEY = "metricsMountPath";

/**
 * Mount this first inside every sub-router (e.g. the /api router).
 * Express resets `req.baseUrl` when an error leaves the sub-router, so without
 * this a failed GET /api/latency would be recorded as "GET /latency".
 */
export const rememberMountPath: RequestHandler = (req, res, next) => {
  res.locals[MOUNT_PATH_KEY] = req.baseUrl;
  next();
};
