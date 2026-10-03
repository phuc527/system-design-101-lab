import compression from "compression";
import { Router } from "express";
import { createAvailabilityController } from "../controllers/availability.controller.js";
import { createBandwidthController } from "../controllers/bandwidth.controller.js";
import { createCapController } from "../controllers/cap.controller.js";
import { createLatencyController } from "../controllers/latency.controller.js";
import { createSystemController } from "../controllers/system.controller.js";
import { createThroughputController } from "../controllers/throughput.controller.js";
import { chaos } from "../middleware/chaos.js";
import { rememberMountPath } from "../middleware/request-metrics.js";
import type { Services } from "../services/index.js";

/**
 * Route map
 *
 *  System (never affected by chaos)
 *    GET  /health                 liveness check
 *    GET  /metrics                RPS, error rate, latency percentiles, event-loop delay
 *    POST /metrics/reset
 *    GET  /chaos | POST /chaos | POST /chaos/reset | POST /chaos/crash
 *
 *  Concept endpoints (/api/* go through the chaos middleware)
 *    GET  /api/hello                         baseline
 *    GET  /api/latency?ms=&tailRate=&tailMs= latency + tail latency
 *    GET  /api/latency/sequential?calls=&ms=
 *    GET  /api/latency/parallel?calls=&ms=
 *    GET  /api/io?ms=                        throughput: I/O-bound
 *    GET  /api/cpu?n=                        throughput: CPU-bound
 *    GET  /api/payload?kb=                   bandwidth + compression
 *    GET  /api/download?kb=&kbps=            bandwidth: throttled stream
 *
 *  Calculators / simulators
 *    GET  /availability?percent=&replicas=&dependencies=
 *    /cap/*                                  CAP theorem simulator
 */
export function createRouter(services: Services): Router {
  const router = Router();
  const system = createSystemController(services);
  const latency = createLatencyController(services);
  const throughput = createThroughputController(services);
  const bandwidth = createBandwidthController(services);
  const availability = createAvailabilityController();
  const cap = createCapController(services);

  router.get("/health", system.health);
  router.get("/metrics", system.metrics);
  router.post("/metrics/reset", system.resetMetrics);
  router.get("/chaos", system.getChaos);
  router.post("/chaos", system.setChaos);
  router.post("/chaos/reset", system.resetChaos);
  router.post("/chaos/crash", system.crash);

  // Chaos is attached per route (not with api.use) so that when it injects a
  // failure, Express already knows which route matched and /metrics can
  // attribute the error to "GET /api/hello" instead of "unmatched".
  const withChaos = chaos(services.chaos);
  const api = Router();
  api.use(rememberMountPath);
  api.get("/hello", withChaos, throughput.hello);
  api.get("/latency", withChaos, latency.single);
  api.get("/latency/sequential", withChaos, latency.sequential);
  api.get("/latency/parallel", withChaos, latency.parallel);
  api.get("/io", withChaos, throughput.io);
  api.get("/cpu", withChaos, throughput.cpu);
  api.get("/payload", withChaos, compression(), bandwidth.payload);
  api.get("/download", withChaos, bandwidth.download);
  router.use("/api", api);

  router.get("/availability", availability.calculate);

  const capRouter = Router();
  capRouter.use(rememberMountPath);
  capRouter.get("/", cap.state);
  capRouter.post("/mode", cap.setMode);
  capRouter.post("/partition", cap.partition);
  capRouter.post("/heal", cap.heal);
  capRouter.post("/reset", cap.reset);
  capRouter.put("/nodes/:node/keys/:key", cap.write);
  capRouter.get("/nodes/:node/keys/:key", cap.read);
  router.use("/cap", capRouter);

  return router;
}
