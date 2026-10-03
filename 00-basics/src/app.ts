import express, { type Express } from "express";
import { errorHandler, notFound } from "./middleware/error-handler.js";
import { instanceHeader } from "./middleware/instance-header.js";
import { requestMetrics } from "./middleware/request-metrics.js";
import { createRouter } from "./routes/index.js";
import type { Services } from "./services/index.js";

/**
 * Builds the Express app WITHOUT starting a server.
 * server.ts calls app.listen(); tests pass the app straight to supertest.
 */
export function createApp(services: Services): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(instanceHeader(services.config.instanceName));
  app.use(requestMetrics(services.stats));
  app.use(express.json({ limit: "100kb" }));

  app.use(createRouter(services));

  app.use(notFound);
  app.use(errorHandler(services.config.instanceName));
  return app;
}
