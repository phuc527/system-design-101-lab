import type { NextFunction, Request, Response } from "express";
import { log } from "../../shared/logger.js";
import { HttpError } from "../errors.js";

export function notFound(req: Request, res: Response): void {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
}

export function errorHandler(instanceName: string) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ error: { code: err.code, message: err.message }, instance: instanceName });
      return;
    }
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
      return;
    }
    log("error", "unhandled error", { path: req.path, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" }, instance: instanceName });
  };
}
