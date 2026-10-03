import express, { type Express } from "express";
import type { ApiConfig } from "./config.js";
import { chaos } from "./middleware/chaos.js";
import { errorHandler, notFound } from "./middleware/error-handler.js";
import { trackRequest } from "./middleware/track-request.js";
import { createRouter } from "./routes/index.js";
import { InstanceState } from "./services/instance-state.js";

export interface ApiApp {
  app: Express;
  state: InstanceState;
}

/** Builds one API instance (without listening) - used by server.ts and by tests. */
export function createApiApp(config: ApiConfig, isShuttingDown: () => boolean = () => false): ApiApp {
  const state = new InstanceState(config.poolSize);
  const app = express();

  app.disable("x-powered-by");
  // While shutting down, ask every client (including load balancers holding
  // keep-alive connections) to close the connection after this response, so
  // their NEXT request opens a new connection - to another instance.
  app.use((_req, res, next) => {
    if (isShuttingDown()) res.setHeader("Connection", "close");
    next();
  });
  app.use(trackRequest(state, config.instanceName));
  app.use(express.json({ limit: "10kb" }));
  app.use(chaos(state, config.instanceName));
  app.use(createRouter(config, state, isShuttingDown));
  app.use(notFound);
  app.use(errorHandler(config.instanceName));

  return { app, state };
}
