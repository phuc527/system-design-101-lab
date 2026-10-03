import type { Request, Response } from "express";
import type { ApiConfig } from "../config.js";
import { BadRequestError } from "../errors.js";
import type { InstanceState } from "../services/instance-state.js";

/**
 * A shopping cart stored IN THIS PROCESS'S MEMORY. This is a deliberate anti-pattern.
 *
 * Behind a round-robin load balancer, "add to cart" lands on api1, the next
 * "view cart" lands on api2, which has never heard of your cart.
 * Fixes you will compare in the experiments:
 *   1. sticky sessions (ip_hash / hash by user) -> same user, same instance
 *   2. shared state (Redis, lab 22)            -> any instance can answer
 */
export function createCartController(config: ApiConfig, state: InstanceState) {
  function userOf(req: Request): string {
    const user = req.header("x-user-id");
    if (!user || user.length > 64) throw new BadRequestError("Send an X-User-Id header (1-64 chars)");
    return user;
  }

  return {
    /** POST /cart/items  { "item": "keyboard" }   header X-User-Id: alice */
    add(req: Request, res: Response): void {
      const user = userOf(req);
      const item: unknown = (req.body as Record<string, unknown> | undefined)?.["item"];
      if (typeof item !== "string" || item.length === 0 || item.length > 100) {
        throw new BadRequestError("item must be a non-empty string (max 100 chars)");
      }
      const items = state.addToCart(user, item);
      res.status(201).json({ instance: config.instanceName, user, items });
    },

    /** GET /cart   header X-User-Id: alice */
    get(req: Request, res: Response): void {
      const user = userOf(req);
      res.json({ instance: config.instanceName, user, items: state.getCart(user) });
    },
  };
}
