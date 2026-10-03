import { log } from "../shared/logger.js";
import { createApiApp } from "./app.js";
import { loadApiConfig } from "./config.js";

/**
 * One API instance. In Docker we run three of these (api1, api2, api3)
 * from the same image; only INSTANCE_NAME differs.
 */
const config = loadApiConfig();
let shuttingDown = false;
const { app } = createApiApp(config, () => shuttingDown);

const server = app.listen(config.port, () => {
  log("info", "api instance listening", { instance: config.instanceName, port: config.port });
});

/**
 * Graceful shutdown ("connection draining"):
 *  1. /health starts returning 503 so load balancers stop sending NEW requests,
 *     and every response carries `Connection: close` (see app.ts)
 *  2. wait DRAIN_MS for load balancers to notice (must be > their detection time)
 *  3. stop accepting connections, let in-flight requests finish, then exit
 *  4. after FORCE_CLOSE_MS, cut whatever connections are left
 * Without this, every deploy would fail the requests that were in flight.
 * The orchestrator's grace period (stop_grace_period) must cover steps 1-4.
 */
const DRAIN_MS = Number(process.env["DRAIN_MS"] ?? 3000);
const FORCE_CLOSE_MS = 5000;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "draining before shutdown", { instance: config.instanceName, signal, drainMs: DRAIN_MS });
  setTimeout(() => {
    log("info", "closing server", { instance: config.instanceName });
    server.close(() => {
      log("info", "all connections closed, exiting", { instance: config.instanceName });
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, FORCE_CLOSE_MS).unref();
  }, DRAIN_MS);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
