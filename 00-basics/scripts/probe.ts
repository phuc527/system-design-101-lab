/**
 * Client-side probe: measures what a USER experiences.
 *
 *   npm run probe -- --url http://localhost:3000/api/hello --n 200
 *   npm run probe -- --url http://localhost:3000/api/hello --n 200 --retries 2
 *
 * Reports success rate (observed availability) and latency percentiles.
 * With --retries, a failed request is retried up to N times: this shows how
 * a client can be RELIABLE on top of an UNRELIABLE server (fault tolerance),
 * and what it costs (extra latency + extra load on the server).
 */
import { parseArgs } from "node:util";
import { summarize } from "../src/services/stats.service.js";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:3000/api/hello" },
    n: { type: "string", default: "100" },
    retries: { type: "string", default: "0" },
    concurrency: { type: "string", default: "10" },
    timeout: { type: "string", default: "5000" },
  },
});

const url = values.url;
const total = Number(values.n);
const maxRetries = Number(values.retries);
const concurrency = Number(values.concurrency);
const timeoutMs = Number(values.timeout);

interface Outcome {
  ok: boolean;
  attempts: number;
  latencyMs: number;
  instance: string | null;
}

async function attempt(): Promise<{ ok: boolean; instance: string | null }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer(); // drain the body
    return { ok: res.ok, instance: res.headers.get("x-instance") };
  } catch {
    return { ok: false, instance: null }; // connection refused, timeout, reset...
  }
}

async function oneRequest(): Promise<Outcome> {
  const start = performance.now();
  let attempts = 0;
  let last: { ok: boolean; instance: string | null } = { ok: false, instance: null };
  while (attempts <= maxRetries) {
    attempts += 1;
    last = await attempt();
    if (last.ok) break;
  }
  return { ok: last.ok, attempts, latencyMs: performance.now() - start, instance: last.instance };
}

async function main(): Promise<void> {
  console.log(`Probing ${url}  n=${total} concurrency=${concurrency} retries=${maxRetries}\n`);
  const outcomes: Outcome[] = [];
  let next = 0;

  // Simple worker pool: `concurrency` loops pulling from a shared counter.
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < total) {
        next += 1;
        outcomes.push(await oneRequest());
      }
    }),
  );

  const ok = outcomes.filter((o) => o.ok).length;
  const totalAttempts = outcomes.reduce((acc, o) => acc + o.attempts, 0);
  const latency = summarize(outcomes.map((o) => o.latencyMs));
  const byInstance = new Map<string, number>();
  for (const o of outcomes) {
    const key = o.instance ?? "(no response)";
    byInstance.set(key, (byInstance.get(key) ?? 0) + 1);
  }

  console.log("Result (what the user sees)");
  console.log(`  succeeded:          ${ok}/${total}`);
  console.log(`  availability:       ${((ok / total) * 100).toFixed(2)}%`);
  console.log(`  HTTP calls made:    ${totalAttempts}  (${(totalAttempts / total).toFixed(2)} per request - retries add load!)`);
  console.log(`  latency ms:         p50=${latency.p50}  p95=${latency.p95}  p99=${latency.p99}  max=${latency.max}`);
  console.log("  answered by:");
  for (const [instance, count] of byInstance) console.log(`    ${instance.padEnd(30)} ${count}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
