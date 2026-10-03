import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

export interface ErrorBody {
  error: { code: string; message: string };
  instance: string;
  pid: number;
}

export function notFound(req: Request, res: Response): void {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
}

/**
 * Single place that turns errors into HTTP responses.
 * Express 5 forwards errors thrown in async handlers here automatically.
 */
export function errorHandler(instanceName: string) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof HttpError) {
      const body: ErrorBody = {
        error: { code: err.code, message: err.message },
        instance: instanceName,
        pid: process.pid,
      };
      res.status(err.statusCode).json(body);
      return;
    }

    // Malformed JSON body from express.json()
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
      return;
    }

    log("error", "unhandled error", {
      method: req.method,
      path: req.path,
      error: err instanceof Error ? err.message : String(err),
    });
    const body: ErrorBody = {
      error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
      instance: instanceName,
      pid: process.pid,
    };
    res.status(500).json(body);
  };
}
