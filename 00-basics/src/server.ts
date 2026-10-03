import cluster from "node:cluster";
import { createApp } from "./app.js";
import { config } from "./config/index.js";
import { createServices } from "./services/index.js";
import { log } from "./utils/logger.js";

/**
 * Entry point.
 *
 * WORKERS=1  -> one process, one event loop, one CPU core used for JavaScript.
 * WORKERS=N  -> Node's cluster module: a PRIMARY process forks N WORKER processes.
 *               They all share port 3000; the primary hands incoming connections
 *               to workers (round-robin on Linux). This is horizontal scaling
 *               on ONE machine - a preview of the load balancer in lab 01.
 */
if (config.workers > 1 && cluster.isPrimary) {
  startPrimary(config.workers);
} else {
  startWorker();
}

function startPrimary(workers: number): void {
  log("info", "primary started", { workers, port: config.port });

  let shuttingDown = false;
  for (let i = 0; i < workers; i++) cluster.fork();

  // Fault tolerance: if a worker dies, replace it. Clients may see errors on
  // in-flight requests of the dead worker, but the service as a whole stays up.
  cluster.on("exit", (worker, code, signal) => {
    if (shuttingDown) return;
    log("warn", "worker died - forking a replacement", { workerPid: worker.process.pid, code, signal });
    cluster.fork();
  });

  const shutdown = (signal: string): void => {
    shuttingDown = true;
    log("info", "primary shutting down", { signal });
    for (const worker of Object.values(cluster.workers ?? {})) worker?.kill("SIGTERM");
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function startWorker(): void {
  const services = createServices(config);
  const app = createApp(services);

  const server = app.listen(config.port, () => {
    log("info", "http server listening", {
      port: config.port,
      instance: config.instanceName,
      role: cluster.isWorker ? "worker" : "single",
    });
  });

  // Graceful shutdown: stop accepting new connections, let in-flight requests finish.
  const shutdown = (signal: string): void => {
    log("info", "shutting down gracefully", { signal });
    services.runtime.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref(); // don't hang forever
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
