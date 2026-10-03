import type { Request, Response } from "express";
import { log } from "../../shared/logger.js";
import type { ApiConfig } from "../config.js";
import { BadRequestError } from "../errors.js";
import { CHAOS_MODES, isChaosMode, type InstanceState } from "../services/instance-state.js";

/**
 * /admin/* - per-instance controls. Never affected by chaos.
 * Call these on the instance's own port (3001-3003) to target ONE instance;
 * through the load balancer you would hit whichever instance it picks.
 */
export function createAdminController(config: ApiConfig, state: InstanceState) {
  const meta = { instance: config.instanceName, pid: process.pid };

  return {
    stats(_req: Request, res: Response): void {
      res.json({ ...meta, ...state.stats(), chaos: state.getChaos() });
    },

    resetStats(_req: Request, res: Response): void {
      state.resetStats();
      res.json({ ...meta, ...state.stats() });
    },

    getChaos(_req: Request, res: Response): void {
      res.json({ ...meta, chaos: state.getChaos() });
    },

    /** POST /admin/chaos  { "mode": "healthy" | "error" | "slow" | "unhealthy", "slowMs"?: number } */
    setChaos(req: Request, res: Response): void {
      const body: unknown = req.body;
      const input = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const mode = input["mode"];
      if (!isChaosMode(mode)) throw new BadRequestError(`mode must be one of: ${CHAOS_MODES.join(", ")}`);

      const slowMsRaw = input["slowMs"] ?? state.getChaos().slowMs;
      if (typeof slowMsRaw !== "number" || !Number.isInteger(slowMsRaw) || slowMsRaw < 0 || slowMsRaw > 60_000) {
        throw new BadRequestError("slowMs must be an integer between 0 and 60000");
      }

      const chaos = state.setChaos({ mode, slowMs: slowMsRaw });
      log("warn", "chaos mode changed", { instance: config.instanceName, ...chaos });
      res.json({ ...meta, chaos });
    },

    /** POST /admin/crash - exit the process. Docker restarts it (restart: unless-stopped). */
    crash(_req: Request, res: Response): void {
      log("error", "crash requested", { instance: config.instanceName });
      res.json({ ...meta, crashing: true });
      setTimeout(() => process.exit(1), 100);
    },
  };
}
