/**
 * Sends requests through a load balancer and shows WHICH instance answered.
 *
 * Batch mode (default): N requests, then a summary.
 *   npm run dist -- --url http://localhost:8090/ --n 300
 *
 * Watch mode: run for S seconds, print one line per second. Use it while you
 * kill / break an instance to SEE failover happen.
 *   npm run dist -- --url http://localhost:8090/ --watch 30
 *
 * Options:
 *   --url URL        target (default http://localhost:8090/)
 *   --n N            number of requests in batch mode (default 300)
 *   --c N            concurrency: requests in flight at once (default 10)
 *   --users N        rotate X-User-Id header over user-1..user-N (sticky-session experiments)
 *   --fake-ips N     rotate X-Forwarded-For over N fake client IPs (node-lb ip-hash experiments)
 *   --watch S        watch mode for S seconds
 *   --timeout MS     per-request timeout (default 10000)
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8090/" },
    n: { type: "string", default: "300" },
    c: { type: "string", default: "10" },
    users: { type: "string", default: "0" },
    "fake-ips": { type: "string", default: "0" },
    watch: { type: "string", default: "0" },
    timeout: { type: "string", default: "10000" },
  },
});

const url = values.url;
const total = Number(values.n);
const concurrency = Number(values.c);
const users = Number(values.users);
const fakeIps = Number(values["fake-ips"]);
const watchSeconds = Number(values.watch);
const timeoutMs = Number(values.timeout);

interface Result {
  instance: string;
  status: number; // 0 = network error / timeout
  ms: number;
}

let seq = 0;

async function oneRequest(): Promise<Result> {
  seq += 1;
  const headers: Record<string, string> = {};
  if (users > 0) headers["x-user-id"] = `user-${(seq % users) + 1}`;
  if (fakeIps > 0) headers["x-forwarded-for"] = `10.0.${Math.floor((seq % fakeIps) / 250)}.${(seq % fakeIps) % 250 + 1}`;

  const start = performance.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer();
    return { instance: res.headers.get("x-instance") ?? "(no instance)", status: res.status, ms: performance.now() - start };
  } catch {
    return { instance: "(network error)", status: 0, ms: performance.now() - start };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function countBy<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0) + 1);
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function summarize(results: Result[], seconds: number): void {
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const errors = results.filter((r) => r.status === 0 || r.status >= 500).length;

  console.log(`\nRequests: ${results.length} in ${seconds.toFixed(1)}s  (${(results.length / seconds).toFixed(0)} req/s)`);
  console.log(`Errors:   ${errors} (${((errors / results.length) * 100).toFixed(1)}%)`);
  console.log(
    `Latency:  p50=${percentile(latencies, 50).toFixed(1)}ms  p95=${percentile(latencies, 95).toFixed(1)}ms  p99=${percentile(latencies, 99).toFixed(1)}ms  max=${(latencies.at(-1) ?? 0).toFixed(1)}ms`,
  );

  console.log("\nAnswered by:");
  for (const [instance, count] of countBy(results, (r) => r.instance)) {
    const pct = (count / results.length) * 100;
    console.log(`  ${instance.padEnd(16)} ${String(count).padStart(6)}  ${pct.toFixed(1).padStart(5)}%  ${"█".repeat(Math.round(pct / 2))}`);
  }

  console.log("\nStatus codes:");
  for (const [status, count] of countBy(results, (r) => (r.status === 0 ? "network error" : String(r.status)))) {
    console.log(`  ${status.padEnd(16)} ${String(count).padStart(6)}`);
  }
}

async function batch(): Promise<void> {
  console.log(`Sending ${total} requests to ${url} (concurrency ${concurrency})`);
  const results: Result[] = [];
  let started = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (started < total) {
        started += 1;
        results.push(await oneRequest());
      }
    }),
  );
  summarize(results, (performance.now() - t0) / 1000);
}

async function watch(): Promise<void> {
  console.log(`Watching ${url} for ${watchSeconds}s (concurrency ${concurrency}). Break something now!\n`);
  const all: Result[] = [];
  let window: Result[] = [];
  const t0 = performance.now();
  const deadline = t0 + watchSeconds * 1000;
  let tick = 0;

  const printer = setInterval(() => {
    tick += 1;
    const counts = countBy(window, (r) => r.instance);
    const errors = window.filter((r) => r.status === 0 || r.status >= 500).length;
    const lat = window.map((r) => r.ms).sort((a, b) => a - b);
    const parts = [...counts.entries()].map(([inst, n]) => `${inst}=${n}`).join("  ");
    console.log(
      `${String(tick).padStart(3)}s  ${parts.padEnd(48)} errors=${String(errors).padEnd(4)} p99=${percentile(lat, 99).toFixed(0)}ms`,
    );
    window = [];
  }, 1000);

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (performance.now() < deadline) {
        const r = await oneRequest();
        window.push(r);
        all.push(r);
      }
    }),
  );
  clearInterval(printer);
  summarize(all, (performance.now() - t0) / 1000);
}

(watchSeconds > 0 ? watch() : batch()).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
