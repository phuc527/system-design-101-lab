import http from "node:http";
import { log } from "../shared/logger.js";
import { createBackend } from "./backend.js";
import { LoadBalancer } from "./balancer.js";
import { loadLbConfig } from "./config.js";
import { HealthChecker } from "./health-checker.js";
import { createStrategy } from "./strategies.js";

/**
 * A hand-written load balancer in ~400 lines of TypeScript.
 * Not for production (use Nginx, HAProxy, Envoy or a cloud LB) - it exists so
 * you can READ how round robin, least connections, health checks, retries and
 * reverse proxying actually work.
 */
const config = loadLbConfig();
const backends = config.backends.map(createBackend);

const balancer = new LoadBalancer(backends, createStrategy(config.strategy), {
  proxyTimeoutMs: config.proxyTimeoutMs,
  healthyThreshold: config.healthCheck.healthyThreshold,
  unhealthyThreshold: config.healthCheck.unhealthyThreshold,
});

const healthChecker = new HealthChecker(backends, config.healthCheck);

const server = http.createServer((req, res) => {
  balancer.handle(req, res).catch((err: unknown) => {
    log("error", "unexpected LB error", { error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) res.writeHead(500).end();
    else res.destroy();
  });
});

server.listen(config.port, () => {
  healthChecker.start();
  log("info", "load balancer listening", {
    port: config.port,
    strategy: config.strategy,
    backends: config.backends,
    healthCheckEveryMs: config.healthCheck.intervalMs,
  });
});

function shutdown(signal: string): void {
  log("info", "load balancer shutting down", { signal });
  healthChecker.stop();
  server.close(() => {
    balancer.close();
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
