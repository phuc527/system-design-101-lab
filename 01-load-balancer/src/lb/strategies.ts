import type { Backend } from "./backend.js";

/**
 * Load-balancing algorithms. Each one answers a single question:
 * "given these healthy backends, which one gets this request?"
 */

export const STRATEGY_NAMES = ["round-robin", "least-connections", "ip-hash", "random"] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

export function isStrategyName(v: unknown): v is StrategyName {
  return typeof v === "string" && (STRATEGY_NAMES as readonly string[]).includes(v);
}

export interface PickContext {
  clientIp: string;
}

export interface Strategy {
  readonly name: StrategyName;
  /** `candidates` are already filtered to healthy (and not-yet-tried) backends. */
  pick(candidates: readonly Backend[], ctx: PickContext): Backend | undefined;
}

/**
 * ROUND ROBIN: 1, 2, 3, 1, 2, 3...
 * Simple and fair when requests cost about the same and servers are identical.
 * Blind to load: a server stuck on slow requests still gets its turn.
 */
export class RoundRobinStrategy implements Strategy {
  readonly name = "round-robin" as const;
  private counter = 0;

  pick(candidates: readonly Backend[]): Backend | undefined {
    if (candidates.length === 0) return undefined;
    const backend = candidates[this.counter % candidates.length];
    this.counter = (this.counter + 1) % 1_000_000_000;
    return backend;
  }
}

/**
 * LEAST CONNECTIONS: send to the backend with the fewest requests in flight.
 * Adapts to uneven request cost and slow servers: a backend that is stuck
 * accumulates in-flight requests and naturally receives fewer new ones.
 * Ties (e.g. everyone idle) are broken round-robin, otherwise backend #1
 * would win every tie.
 */
export class LeastConnectionsStrategy implements Strategy {
  readonly name = "least-connections" as const;
  private tieBreaker = 0;

  pick(candidates: readonly Backend[]): Backend | undefined {
    if (candidates.length === 0) return undefined;
    const min = Math.min(...candidates.map((b) => b.activeConnections));
    const tied = candidates.filter((b) => b.activeConnections === min);
    const backend = tied[this.tieBreaker % tied.length];
    this.tieBreaker = (this.tieBreaker + 1) % 1_000_000_000;
    return backend;
  }
}

/**
 * IP HASH: hash(client IP) % N -> the same client always lands on the same
 * backend ("sticky sessions") while the set of healthy backends is unchanged.
 *
 * Caveats you will see in the experiments:
 *  - all users behind one NAT / corporate proxy share an IP -> one hot backend
 *  - when N changes (a backend dies), most clients get remapped
 *    (consistent hashing fixes this - lab 06)
 */
export class IpHashStrategy implements Strategy {
  readonly name = "ip-hash" as const;

  pick(candidates: readonly Backend[], ctx: PickContext): Backend | undefined {
    if (candidates.length === 0) return undefined;
    return candidates[fnv1a(ctx.clientIp) % candidates.length];
  }
}

/**
 * RANDOM: surprisingly decent at large scale, but noisy at low volume.
 * (Production variant: "power of two choices" - pick 2 at random, take the less loaded.)
 */
export class RandomStrategy implements Strategy {
  readonly name = "random" as const;
  constructor(private readonly random: () => number = Math.random) {}

  pick(candidates: readonly Backend[]): Backend | undefined {
    if (candidates.length === 0) return undefined;
    return candidates[Math.floor(this.random() * candidates.length)];
  }
}

export function createStrategy(name: StrategyName): Strategy {
  switch (name) {
    case "round-robin":
      return new RoundRobinStrategy();
    case "least-connections":
      return new LeastConnectionsStrategy();
    case "ip-hash":
      return new IpHashStrategy();
    case "random":
      return new RandomStrategy();
  }
}

/** FNV-1a 32-bit: a tiny, fast, well-distributed (non-cryptographic) string hash. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
