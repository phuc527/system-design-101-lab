import { ConfigError, readNumber, readString } from "../shared/env.js";
import { isStrategyName, STRATEGY_NAMES, type StrategyName } from "./strategies.js";

export interface LbConfig {
  readonly port: number;
  readonly backends: readonly string[];
  readonly strategy: StrategyName;
  readonly healthCheck: {
    readonly intervalMs: number;
    readonly timeoutMs: number;
    readonly path: string;
    /** consecutive failures before a backend is marked DOWN */
    readonly unhealthyThreshold: number;
    /** consecutive successes before a DOWN backend is marked UP again */
    readonly healthyThreshold: number;
  };
  /** max time to wait for a backend (idle socket) before failing the attempt */
  readonly proxyTimeoutMs: number;
}

export function loadLbConfig(): LbConfig {
  const backends = readString("BACKENDS", "http://localhost:3001,http://localhost:3002,http://localhost:3003")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const b of backends) {
    // Note: new URL("api1:3000") does NOT throw - it parses as protocol "api1:".
    // So also require http:, which is the only protocol this proxy speaks.
    let protocol = "";
    try {
      protocol = new URL(b).protocol;
    } catch {
      // handled below
    }
    if (protocol !== "http:") throw new ConfigError(`BACKENDS contains an invalid URL: "${b}" (expected http://host:port)`);
  }
  if (backends.length === 0) throw new ConfigError("BACKENDS must list at least one URL");

  const strategy = readString("LB_STRATEGY", "round-robin");
  if (!isStrategyName(strategy)) {
    throw new ConfigError(`LB_STRATEGY must be one of ${STRATEGY_NAMES.join(", ")}, got "${strategy}"`);
  }

  return Object.freeze({
    port: readNumber("LB_PORT", 8091, 1, 65535),
    backends,
    strategy,
    healthCheck: Object.freeze({
      intervalMs: readNumber("HEALTH_CHECK_INTERVAL_MS", 2000, 100, 60_000),
      timeoutMs: readNumber("HEALTH_CHECK_TIMEOUT_MS", 1000, 50, 30_000),
      path: readString("HEALTH_CHECK_PATH", "/health"),
      unhealthyThreshold: readNumber("UNHEALTHY_THRESHOLD", 2, 1, 20),
      healthyThreshold: readNumber("HEALTHY_THRESHOLD", 2, 1, 20),
    }),
    proxyTimeoutMs: readNumber("PROXY_TIMEOUT_MS", 5000, 100, 120_000),
  });
}
