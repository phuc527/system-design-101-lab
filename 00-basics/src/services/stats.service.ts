/**
 * In-memory request statistics: count, error rate, RPS and latency percentiles.
 *
 * WHY percentiles instead of averages?
 *   99 requests take 10ms and 1 request takes 5000ms.
 *   average = 59.9ms  -> "looks fine"
 *   p99     = 5000ms  -> "1 in 100 users waits 5 seconds"
 * Averages hide the slow requests your users actually complain about.
 *
 * NOTE: this state lives inside ONE process. In cluster mode every worker has
 * its own StatsService, so /metrics answers differ depending on which worker
 * you hit. That is exactly the "stateful server" problem that later labs
 * (Redis, observability, horizontal scaling) solve.
 */

export interface LatencySummary {
  samples: number;
  min: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface RouteStats {
  count: number;
  errors: number;
  avgMs: number;
}

export interface StatsSnapshot {
  totalRequests: number;
  totalErrors: number;
  /** errors / requests, 0..1 (5xx responses only - a 4xx is the client's fault) */
  errorRate: number;
  /** Observed availability = 1 - errorRate, as a percentage */
  availabilityPercent: number;
  /** Average requests per second over the last `rpsWindowSeconds` seconds */
  rps: number;
  rpsWindowSeconds: number;
  latencyMs: LatencySummary;
  routes: Record<string, RouteStats>;
}

/**
 * Nearest-rank percentile. `sorted` MUST be sorted ascending.
 * p95 of 100 samples = the 95th smallest value: 95% of requests were this fast or faster.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

export function summarize(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {
    return { samples: 0, min: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const round = (n: number): number => Math.round(n * 100) / 100;

  return {
    samples: sorted.length,
    min: round(sorted[0] ?? 0),
    avg: round(sum / sorted.length),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

interface MutableRouteStats {
  count: number;
  errors: number;
  totalMs: number;
}

export class StatsService {
  /** Ring buffer: keeps only the last `windowSize` latencies so memory stays bounded. */
  private readonly latencies: number[] = [];
  private nextSlot = 0;
  private totalRequests = 0;
  private totalErrors = 0;
  /** unix-second -> request count, for RPS */
  private readonly perSecond = new Map<number, number>();
  private readonly routes = new Map<string, MutableRouteStats>();

  constructor(
    private readonly windowSize = 1000,
    private readonly rpsWindowSeconds = 10,
    private readonly now: () => number = Date.now,
  ) {}

  record(route: string, durationMs: number, statusCode: number): void {
    const isError = statusCode >= 500;
    this.totalRequests += 1;
    if (isError) this.totalErrors += 1;

    // ring buffer write
    if (this.latencies.length < this.windowSize) {
      this.latencies.push(durationMs);
    } else {
      this.latencies[this.nextSlot] = durationMs;
    }
    this.nextSlot = (this.nextSlot + 1) % this.windowSize;

    // per-second bucket for RPS
    const second = Math.floor(this.now() / 1000);
    this.perSecond.set(second, (this.perSecond.get(second) ?? 0) + 1);
    this.pruneBuckets(second);

    // per-route stats
    const r = this.routes.get(route) ?? { count: 0, errors: 0, totalMs: 0 };
    r.count += 1;
    r.totalMs += durationMs;
    if (isError) r.errors += 1;
    this.routes.set(route, r);
  }

  snapshot(): StatsSnapshot {
    const currentSecond = Math.floor(this.now() / 1000);
    this.pruneBuckets(currentSecond);

    // Only count *completed* seconds so a half-finished second does not drag RPS down.
    let windowCount = 0;
    for (const [second, count] of this.perSecond) {
      if (second < currentSecond && second >= currentSecond - this.rpsWindowSeconds) {
        windowCount += count;
      }
    }

    const errorRate = this.totalRequests === 0 ? 0 : this.totalErrors / this.totalRequests;
    const routes: Record<string, RouteStats> = {};
    for (const [name, r] of this.routes) {
      routes[name] = {
        count: r.count,
        errors: r.errors,
        avgMs: Math.round((r.totalMs / r.count) * 100) / 100,
      };
    }

    return {
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      errorRate: Math.round(errorRate * 10_000) / 10_000,
      availabilityPercent: Math.round((1 - errorRate) * 1_000_000) / 10_000,
      rps: Math.round((windowCount / this.rpsWindowSeconds) * 100) / 100,
      rpsWindowSeconds: this.rpsWindowSeconds,
      latencyMs: summarize(this.latencies),
      routes,
    };
  }

  reset(): void {
    this.latencies.length = 0;
    this.nextSlot = 0;
    this.totalRequests = 0;
    this.totalErrors = 0;
    this.perSecond.clear();
    this.routes.clear();
  }

  private pruneBuckets(currentSecond: number): void {
    for (const second of this.perSecond.keys()) {
      if (second < currentSecond - this.rpsWindowSeconds - 1) this.perSecond.delete(second);
    }
  }
}
