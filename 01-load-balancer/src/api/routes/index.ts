import { Router } from "express";
import type { ApiConfig } from "../config.js";
import { createAdminController } from "../controllers/admin.controller.js";
import { createCartController } from "../controllers/cart.controller.js";
import { createHealthController } from "../controllers/health.controller.js";
import { createWorkController } from "../controllers/work.controller.js";
import type { InstanceState } from "../services/instance-state.js";

/**
 *   GET  /                 who answered? (instance, request number, in-flight)
 *   GET  /work?ms=100      simulated DB query using a pool of POOL_SIZE connections
 *   GET  /cpu?n=30         CPU-bound work
 *   GET  /health           health check polled by load balancers
 *   POST /cart/items       in-memory cart (stateful anti-pattern demo)
 *   GET  /cart
 *   GET  /admin/stats      per-instance counters
 *   POST /admin/stats/reset
 *   GET  /admin/chaos | POST /admin/chaos
 *   POST /admin/crash
 */
export function createRouter(config: ApiConfig, state: InstanceState, isShuttingDown: () => boolean): Router {
  const router = Router();
  const work = createWorkController(config, state);
  const health = createHealthController(config, state, isShuttingDown);
  const cart = createCartController(config, state);
  const admin = createAdminController(config, state);

  router.get("/", work.whoami);
  router.get("/work", work.work);
  router.get("/cpu", work.cpu);
  router.get("/health", health.health);

  router.post("/cart/items", cart.add);
  router.get("/cart", cart.get);

  router.get("/admin/stats", admin.stats);
  router.post("/admin/stats/reset", admin.resetStats);
  router.get("/admin/chaos", admin.getChaos);
  router.post("/admin/chaos", admin.setChaos);
  router.post("/admin/crash", admin.crash);

  return router;
}
