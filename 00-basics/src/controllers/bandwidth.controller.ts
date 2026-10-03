import type { Request, Response } from "express";
import type { Services } from "../services/index.js";
import { buildPayload } from "../services/payload.service.js";
import { intQuery } from "../utils/query.js";
import { sleep } from "../utils/sleep.js";

/**
 * BANDWIDTH = how many bytes per second the network link can carry.
 *
 *   transfer time ~= latency + (size / bandwidth)
 *
 * Latency is the length of the pipe, bandwidth is its width.
 * A 5 MB response over a 1 MB/s link takes >= 5 seconds no matter how fast your code is.
 */
export function createBandwidthController({ config }: Services) {
  return {
    /**
     * GET /api/payload?kb=500
     * Returns ~kb KB of JSON. The route is wrapped in compression middleware,
     * so clients that send `Accept-Encoding: gzip` get far fewer bytes.
     */
    payload(req: Request, res: Response): void {
      const kb = intQuery(req, "kb", 100, 1, config.limits.maxPayloadKb);
      res.type("application/json").send(buildPayload(kb));
    },

    /**
     * GET /api/download?kb=200&kbps=50
     * Streams `kb` KB but never faster than `kbps` KB/s - a simulated slow network.
     * Expected duration ~= kb / kbps seconds (200 / 50 = 4s).
     */
    async download(req: Request, res: Response): Promise<void> {
      const kb = intQuery(req, "kb", 200, 1, config.limits.maxPayloadKb);
      const kbps = intQuery(req, "kbps", 50, 1, 1_000_000);

      const totalBytes = kb * 1024;
      const ticksPerSecond = 10;
      const bytesPerTick = Math.max(1, Math.floor((kbps * 1024) / ticksPerSecond));

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", String(totalBytes));
      res.setHeader("X-Expected-Seconds", String(Math.round((kb / kbps) * 100) / 100));

      // Stop streaming if the client gives up (closed tab, Ctrl+C on curl).
      let clientGone = false;
      res.on("close", () => {
        clientGone = true;
      });

      let sent = 0;
      while (sent < totalBytes && !clientGone) {
        const size = Math.min(bytesPerTick, totalBytes - sent);
        res.write(Buffer.alloc(size, 0x61)); // 'a' repeated
        sent += size;
        if (sent < totalBytes) await sleep(1000 / ticksPerSecond);
      }
      res.end();
    },
  };
}
