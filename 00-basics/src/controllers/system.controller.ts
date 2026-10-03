import type { Request, Response } from "express";
import { parseChaosPatch } from "../services/chaos.service.js";
import type { Services } from "../services/index.js";
import { BadRequestError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

/**
 * Operational endpoints: health, metrics and chaos controls.
 * These are NOT affected by chaos, so you can always observe the server.
 */
export function createSystemController({ config, stats, runtime, chaos }: Services) {
  const meta = { instance: config.instanceName, pid: process.pid };

  return {
    health(_req: Request, res: Response): void {
      res.json({ status: "ok", ...meta, uptimeSeconds: Math.round(process.uptime()) });
    },

    metrics(_req: Request, res: Response): void {
      res.json({ ...meta, requests: stats.snapshot(), runtime: runtime.snapshot(), chaos: chaos.get() });
    },

    resetMetrics(_req: Request, res: Response): void {
      stats.reset();
      res.json({ ...meta, reset: true });
    },

    getChaos(_req: Request, res: Response): void {
      res.json({ ...meta, chaos: chaos.get() });
    },

    setChaos(req: Request, res: Response): void {
      const patch = parseChaosPatch(req.body);
      if (typeof patch === "string") throw new BadRequestError(patch);
      const updated = chaos.update(patch);
      log("warn", "chaos settings changed", { ...updated });
      res.json({ ...meta, chaos: updated });
    },

    resetChaos(_req: Request, res: Response): void {
      res.json({ ...meta, chaos: chaos.reset() });
    },

    /**
     * Kill this process on purpose. What happens next depends on WHO supervises it:
     *  - `npm run dev` alone      -> nothing restarts it: the server is gone (single point of failure)
     *  - cluster mode (WORKERS>1) -> the primary process forks a replacement worker
     *  - Docker `restart: unless-stopped` -> Docker restarts the container
     */
    crash(_req: Request, res: Response): void {
      log("error", "crash requested - exiting with code 1");
      res.json({ ...meta, crashing: true, message: "This process will exit in 100ms" });
      setTimeout(() => process.exit(1), 100);
    },
  };
}
