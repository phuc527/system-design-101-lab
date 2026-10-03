import type { Request, Response } from "express";
import type { ApiConfig } from "../config.js";
import type { InstanceState } from "../services/instance-state.js";

/**
 * GET /health - what load balancers poll to decide "send traffic here or not".
 *
 * Returns 503 when:
 *  - chaos mode is "unhealthy" (the app works but reports itself unhealthy)
 *  - the process is shutting down (so the LB drains traffic away before we exit)
 */
export function createHealthController(config: ApiConfig, state: InstanceState, isShuttingDown: () => boolean) {
  return {
    health(_req: Request, res: Response): void {
      const { mode } = state.getChaos();
      const shuttingDown = isShuttingDown();
      const healthy = mode !== "unhealthy" && !shuttingDown;
      res.status(healthy ? 200 : 503).json({
        status: healthy ? "ok" : "unhealthy",
        reason: shuttingDown ? "shutting down" : mode === "unhealthy" ? "chaos mode unhealthy" : undefined,
        instance: config.instanceName,
        uptimeSeconds: Math.round(process.uptime()),
      });
    },
  };
}
