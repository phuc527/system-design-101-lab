import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { InstanceState } from "../services/instance-state.js";

/**
 * Counts requests served and requests currently in flight on this instance,
 * and tags every response with `X-Instance` so you (and the distribution
 * script) can see which backend the load balancer picked.
 *
 * "In flight" is exactly what a least-connections load balancer tries to balance.
 */
export function trackRequest(state: InstanceState, instanceName: string): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const requestNumber = state.begin();
    res.locals["requestNumber"] = requestNumber;
    res.setHeader("X-Instance", instanceName);

    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      state.end();
    };
    res.on("finish", finish);
    res.on("close", finish); // client disconnected before we answered

    next();
  };
}
