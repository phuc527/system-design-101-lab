import type { Request, Response } from "express";
import { availabilityReport } from "../services/availability.service.js";
import { floatQuery, intQuery } from "../utils/query.js";

/**
 * GET /availability?percent=99.9&replicas=2&dependencies=3
 *
 * A calculator, not a simulation: shows the downtime budget for an availability
 * target, how dependencies in SERIES reduce it, and how replicas in PARALLEL raise it.
 */
export function createAvailabilityController() {
  return {
    calculate(req: Request, res: Response): void {
      const percent = floatQuery(req, "percent", 99.9, 0, 100);
      const replicas = intQuery(req, "replicas", 2, 1, 10);
      const dependencies = intQuery(req, "dependencies", 3, 1, 20);
      res.json(availabilityReport(percent, replicas, dependencies));
    },
  };
}
