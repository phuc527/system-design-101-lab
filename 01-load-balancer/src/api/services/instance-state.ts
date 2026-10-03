import { ResourcePool, type PoolStats } from "./resource-pool.js";

/**
 * Everything ONE API instance keeps in its own memory.
 *
 * - counters (requests served, requests in flight)
 * - chaos mode, so you can make this instance misbehave on purpose
 * - shopping carts: deliberately stored in memory to demonstrate the
 *   "stateful server behind a load balancer" problem. With round robin,
 *   your cart items end up scattered over 3 instances.
 */

export type ChaosMode =
  /** normal behaviour */
  | "healthy"
  /** every request (including /health) returns HTTP 500: a broken server */
  | "error"
  /** every request (including /health) is delayed by `slowMs`: an overloaded server */
  | "slow"
  /** only /health returns 503, real traffic still works: a "lying" health check */
  | "unhealthy";

export const CHAOS_MODES: readonly ChaosMode[] = ["healthy", "error", "slow", "unhealthy"];

export function isChaosMode(v: unknown): v is ChaosMode {
  return typeof v === "string" && (CHAOS_MODES as readonly string[]).includes(v);
}

export interface ChaosSettings {
  mode: ChaosMode;
  slowMs: number;
}

export interface InstanceStats {
  requestsServed: number;
  inFlight: number;
  maxInFlight: number;
  pool: PoolStats;
  startedAt: string;
}

export class InstanceState {
  private requestsServed = 0;
  private inFlight = 0;
  private maxInFlight = 0;
  private readonly startedAt = new Date().toISOString();
  private chaos: ChaosSettings = { mode: "healthy", slowMs: 2000 };
  private readonly carts = new Map<string, string[]>();
  /** Simulated DB connection pool used by /work. */
  readonly pool: ResourcePool;

  constructor(poolSize = 10) {
    this.pool = new ResourcePool(poolSize);
  }

  /** Called when a request starts. Returns the request number on this instance. */
  begin(): number {
    this.requestsServed += 1;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return this.requestsServed;
  }

  end(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  stats(): InstanceStats {
    return {
      requestsServed: this.requestsServed,
      inFlight: this.inFlight,
      maxInFlight: this.maxInFlight,
      pool: this.pool.stats(),
      startedAt: this.startedAt,
    };
  }

  resetStats(): void {
    this.requestsServed = 0;
    this.maxInFlight = this.inFlight;
  }

  getChaos(): ChaosSettings {
    return { ...this.chaos };
  }

  setChaos(settings: ChaosSettings): ChaosSettings {
    this.chaos = { ...settings };
    return this.getChaos();
  }

  addToCart(user: string, item: string): string[] {
    const items = this.carts.get(user) ?? [];
    items.push(item);
    this.carts.set(user, items);
    return [...items];
  }

  getCart(user: string): string[] {
    return [...(this.carts.get(user) ?? [])];
  }
}
