import type { Request } from "express";
import { BadRequestError } from "./errors.js";

/**
 * Read an integer query parameter with bounds checking.
 * `/api/latency?ms=abc` -> 400 instead of silently treating it as 0 or NaN.
 */
export function intQuery(req: Request, name: string, fallback: number, min: number, max: number): number {
  const raw = req.query[name];
  if (raw === undefined) return fallback;
  if (typeof raw !== "string") throw new BadRequestError(`"${name}" must be a single value`);

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestError(`"${name}" must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function floatQuery(req: Request, name: string, fallback: number, min: number, max: number): number {
  const raw = req.query[name];
  if (raw === undefined) return fallback;
  if (typeof raw !== "string") throw new BadRequestError(`"${name}" must be a single value`);

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new BadRequestError(`"${name}" must be a number between ${min} and ${max}`);
  }
  return value;
}
