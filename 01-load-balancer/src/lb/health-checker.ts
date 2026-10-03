import { log } from "../shared/logger.js";
import { recordFailure, recordSuccess, type Backend } from "./backend.js";

/**
 * ACTIVE health checks: every `intervalMs`, call GET <backend>/health.
 * 2xx within `timeoutMs` = success, anything else (error, timeout, 5xx) = failure.
 *
 * Active vs passive:
 *  - active  : the LB probes on its own schedule. Detects problems even with
 *              zero traffic, and brings recovered servers back automatically.
 *  - passive : the LB watches REAL requests fail (see balancer.ts). No extra
 *              traffic, but a few real users pay for the detection.
 * Open-source Nginx only has passive checks; NGINX Plus, HAProxy, Envoy and
 * cloud load balancers (AWS ALB...) have both.
 */

/** Returns the HTTP status code, or throws on network error / timeout. */
export type HealthProbe = (url: string, timeoutMs: number) => Promise<number>;

export const fetchProbe: HealthProbe = async (url, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  await res.arrayBuffer(); // drain so the connection can be reused
  return res.status;
};

export interface HealthCheckOptions {
  intervalMs: number;
  timeoutMs: number;
  path: string;
  healthyThreshold: number;
  unhealthyThreshold: number;
}

export class HealthChecker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly backends: readonly Backend[],
    private readonly options: HealthCheckOptions,
    private readonly probe: HealthProbe = fetchProbe,
  ) {}

  start(): void {
    void this.checkAll(); // check immediately, don't wait one interval
    this.timer = setInterval(() => void this.checkAll(), this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Probe every backend in parallel. Public so tests can drive it step by step. */
  async checkAll(): Promise<void> {
    if (this.running) return; // previous round still in progress (slow backends)
    this.running = true;
    try {
      await Promise.all(this.backends.map((b) => this.checkOne(b)));
    } finally {
      this.running = false;
    }
  }

  private async checkOne(backend: Backend): Promise<void> {
    const url = new URL(this.options.path, backend.url).toString();
    let transition;
    try {
      const status = await this.probe(url, this.options.timeoutMs);
      transition =
        status >= 200 && status < 300
          ? recordSuccess(backend, this.options.healthyThreshold)
          : recordFailure(backend, this.options.unhealthyThreshold, `health check returned HTTP ${status}`);
    } catch (err) {
      const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      transition = recordFailure(backend, this.options.unhealthyThreshold, `health check failed: ${reason}`);
    }

    if (transition === "went-down") {
      log("warn", "backend DOWN (active health check)", { backend: backend.id, reason: backend.lastError });
    } else if (transition === "went-up") {
      log("info", "backend UP (active health check)", { backend: backend.id });
    }
  }
}
