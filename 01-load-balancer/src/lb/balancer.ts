import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { log } from "../shared/logger.js";
import { recordFailure, type Backend } from "./backend.js";
import { forward } from "./proxy.js";
import { createStrategy, isStrategyName, STRATEGY_NAMES, type Strategy } from "./strategies.js";

/**
 * The load balancer: pick a healthy backend, proxy the request, and if the
 * attempt fails, record a PASSIVE health-check failure and retry ONCE on a
 * different backend (only for GET/HEAD - see proxy.ts).
 *
 * Admin endpoints (not proxied):
 *   GET  /lb/health                         the LB's own health
 *   GET  /lb/status                         strategy + every backend's state
 *   POST /lb/strategy?name=least-connections switch algorithm at runtime
 */

const RETRYABLE_METHODS = new Set(["GET", "HEAD"]);
const MAX_ATTEMPTS = 2;

export interface BalancerOptions {
  proxyTimeoutMs: number;
  healthyThreshold: number;
  unhealthyThreshold: number;
}

export interface BackendStatus {
  id: string;
  url: string;
  healthy: boolean;
  activeConnections: number;
  totalRequests: number;
  totalFailures: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastStateChange: string;
}

export interface LbStatus {
  strategy: string;
  healthyBackends: number;
  totalBackends: number;
  backends: BackendStatus[];
}

export class LoadBalancer {
  private readonly agent = new http.Agent({ keepAlive: true, maxSockets: 512 });

  constructor(
    private readonly backends: readonly Backend[],
    private strategy: Strategy,
    private readonly options: BalancerOptions,
  ) {}

  /** Entry point for every incoming request. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url?.startsWith("/lb/")) {
      this.handleAdmin(req, res);
      return;
    }

    const clientIp = clientIpOf(req);
    const retryable = RETRYABLE_METHODS.has(req.method ?? "");
    const maxAttempts = retryable ? MAX_ATTEMPTS : 1;
    const tried = new Set<Backend>();
    let lastReason = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const candidates = this.backends.filter((b) => b.healthy && !tried.has(b));
      const backend = this.strategy.pick(candidates, { clientIp });
      if (!backend) break;
      tried.add(backend);

      // Only allow "fail silently and retry" if another healthy backend is left to try.
      const canRetry = retryable && attempt < maxAttempts && candidates.length > 1;

      backend.activeConnections += 1;
      backend.totalRequests += 1;
      let outcome;
      try {
        outcome = await forward(req, res, backend, {
          agent: this.agent,
          timeoutMs: this.options.proxyTimeoutMs,
          clientIp,
          canRetry,
        });
      } finally {
        backend.activeConnections -= 1;
      }

      if (outcome.kind === "responded") {
        // A successful request deliberately does NOT count as a health "success":
        // if it did, a steady stream of OK requests would keep resetting the failure
        // streak, and a backend whose /health says 503 (e.g. draining for shutdown)
        // would never be taken out of rotation. Only active checks bring a backend back.
        if (outcome.statusCode >= 500) this.passiveFailure(backend, `backend returned HTTP ${outcome.statusCode}`);
        return;
      }

      lastReason = outcome.reason;
      this.passiveFailure(backend, outcome.reason);
      log("warn", "attempt failed", { backend: backend.id, attempt, reason: outcome.reason, willRetry: canRetry });
    }

    if (res.headersSent) return;
    const noBackends = tried.size === 0;
    sendJson(res, noBackends ? 503 : 502, {
      error: {
        code: noBackends ? "NO_HEALTHY_BACKENDS" : "BAD_GATEWAY",
        message: noBackends ? "All backends are marked DOWN" : `All attempts failed: ${lastReason}`,
      },
      tried: [...tried].map((b) => b.id),
    });
  }

  setStrategy(strategy: Strategy): void {
    this.strategy = strategy;
  }

  status(): LbStatus {
    return {
      strategy: this.strategy.name,
      healthyBackends: this.backends.filter((b) => b.healthy).length,
      totalBackends: this.backends.length,
      backends: this.backends.map((b) => ({
        id: b.id,
        url: b.url.toString(),
        healthy: b.healthy,
        activeConnections: b.activeConnections,
        totalRequests: b.totalRequests,
        totalFailures: b.totalFailures,
        consecutiveFailures: b.consecutiveFailures,
        lastError: b.lastError,
        lastStateChange: b.lastStateChange,
      })),
    };
  }

  close(): void {
    this.agent.destroy();
  }

  private passiveFailure(backend: Backend, reason: string): void {
    if (recordFailure(backend, this.options.unhealthyThreshold, reason) === "went-down") {
      log("warn", "backend DOWN (passive: real requests failing)", { backend: backend.id, reason });
    }
  }

  private handleAdmin(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://lb");

    if (req.method === "GET" && url.pathname === "/lb/health") {
      sendJson(res, 200, { status: "ok" });
    } else if (req.method === "GET" && url.pathname === "/lb/status") {
      sendJson(res, 200, this.status());
    } else if (req.method === "POST" && url.pathname === "/lb/strategy") {
      const name = url.searchParams.get("name");
      if (!isStrategyName(name)) {
        sendJson(res, 400, { error: { code: "BAD_REQUEST", message: `name must be one of ${STRATEGY_NAMES.join(", ")}` } });
        return;
      }
      this.setStrategy(createStrategy(name));
      log("info", "strategy changed", { strategy: name });
      sendJson(res, 200, { strategy: name });
    } else {
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: `No LB admin route ${req.method} ${url.pathname}` } });
    }
  }
}

/**
 * The client's IP. If a trusted proxy in front of us set X-Forwarded-For, use
 * its first entry. SECURITY: only trust this header when the LB sits behind a
 * proxy you control - otherwise any client can spoof it to pick its backend.
 * (Allowed here so the experiments can simulate many clients.)
 */
export function clientIpOf(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}
