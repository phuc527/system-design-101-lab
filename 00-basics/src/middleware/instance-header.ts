import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Adds `X-Instance: <name>/<pid>` to every response.
 * When several processes/containers serve traffic, this tells you WHICH one answered.
 */
export function instanceHeader(instanceName: string): RequestHandler {
  const value = `${instanceName}/${process.pid}`;
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("X-Instance", value);
    next();
  };
}
