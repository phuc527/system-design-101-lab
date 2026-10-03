import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { InstanceState } from "../services/instance-state.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Applies this instance's chaos mode to every request EXCEPT /admin/*
 * (so you can always switch it back).
 *
 *   error     -> 500 for everything, /health included
 *   slow      -> delay everything by slowMs, /health included
 *   unhealthy -> only /health fails (handled in the health controller)
 */
export function chaos(state: InstanceState, instanceName: string): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.path.startsWith("/admin")) return next();

    const { mode, slowMs } = state.getChaos();
    if (mode === "slow") await sleep(slowMs);
    if (mode === "error") {
      res.status(500).json({
        error: { code: "CHAOS_ERROR", message: `${instanceName} is in chaos mode "error"` },
        instance: instanceName,
      });
      return;
    }
    next();
  };
}
