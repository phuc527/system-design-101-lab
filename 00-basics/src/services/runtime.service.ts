import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/**
 * Process-level health signals: memory, CPU time and event-loop delay.
 *
 * Event-loop delay is THE metric for Node.js throughput problems:
 * Node runs your JavaScript on a single thread. If one request does 2 seconds
 * of CPU work, every other request waits 2 seconds - the loop is "blocked".
 * A healthy server shows a delay of ~0-20ms. A blocked one shows hundreds+.
 */
export interface RuntimeSnapshot {
  pid: number;
  uptimeSeconds: number;
  memoryMb: { rss: number; heapUsed: number; heapTotal: number };
  cpuSeconds: { user: number; system: number };
  eventLoopDelayMs: { p50: number; p99: number; max: number };
}

export class RuntimeService {
  private readonly histogram: IntervalHistogram;

  constructor() {
    this.histogram = monitorEventLoopDelay({ resolution: 10 });
    this.histogram.enable();
  }

  snapshot(): RuntimeSnapshot {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;
    // histogram values are in nanoseconds
    const ms = (ns: number): number => Math.round((ns / 1e6) * 10) / 10;

    const snapshot: RuntimeSnapshot = {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal) },
      cpuSeconds: {
        user: Math.round(cpu.user / 1e4) / 100,
        system: Math.round(cpu.system / 1e4) / 100,
      },
      eventLoopDelayMs: {
        p50: ms(this.histogram.percentile(50)),
        p99: ms(this.histogram.percentile(99)),
        max: ms(this.histogram.max),
      },
    };
    // Reset so each /metrics call shows the delay since the previous call.
    this.histogram.reset();
    return snapshot;
  }

  stop(): void {
    this.histogram.disable();
  }
}
