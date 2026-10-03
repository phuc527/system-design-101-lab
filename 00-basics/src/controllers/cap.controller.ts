import type { Request, Response } from "express";
import { isConsistencyMode, isNodeId, type NodeId } from "../services/cap.service.js";
import type { Services } from "../services/index.js";
import { BadRequestError } from "../utils/errors.js";

/**
 * HTTP wrapper around the CAP simulator (see cap.service.ts for the theory).
 *
 * Run this with WORKERS=1: the simulated cluster lives in process memory,
 * so with several workers each one would have its own separate "cluster".
 */
export function createCapController({ cap }: Services) {
  return {
    state(_req: Request, res: Response): void {
      res.json(cap.state());
    },

    /** POST /cap/mode  { "mode": "CP" | "AP" } */
    setMode(req: Request, res: Response): void {
      const mode: unknown = (req.body as Record<string, unknown> | undefined)?.["mode"];
      if (!isConsistencyMode(mode)) throw new BadRequestError('mode must be "CP" or "AP"');
      res.json(cap.setMode(mode));
    },

    /** POST /cap/partition - cut the network link between A and B */
    partition(_req: Request, res: Response): void {
      res.json(cap.partition());
    },

    /** POST /cap/heal - restore the link and reconcile with Last-Write-Wins */
    heal(_req: Request, res: Response): void {
      res.json(cap.heal());
    },

    /** PUT /cap/nodes/:node/keys/:key  { "value": "..." } */
    write(req: Request, res: Response): void {
      const node = parseNode(req.params["node"]);
      const key = parseKey(req.params["key"]);
      const value: unknown = (req.body as Record<string, unknown> | undefined)?.["value"];
      if (typeof value !== "string") throw new BadRequestError("value must be a string");
      res.json(cap.write(node, key, value));
    },

    /** GET /cap/nodes/:node/keys/:key */
    read(req: Request, res: Response): void {
      const node = parseNode(req.params["node"]);
      const key = parseKey(req.params["key"]);
      res.json(cap.read(node, key));
    },

    reset(_req: Request, res: Response): void {
      res.json(cap.reset());
    },
  };
}

function parseNode(raw: string | string[] | undefined): NodeId {
  if (!isNodeId(raw)) throw new BadRequestError('node must be "A" or "B"');
  return raw;
}

function parseKey(raw: string | string[] | undefined): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 100) {
    throw new BadRequestError("key must be 1-100 characters");
  }
  return raw;
}
