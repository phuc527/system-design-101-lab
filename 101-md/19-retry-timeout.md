# 19 — Retry & Timeout

> Every network call can hang forever or fail randomly. Timeouts bound the waiting; retries recover from blips. Done wrong, both cause outages.

---

## 1. Timeouts

### The problem
Node's `fetch` and `http.request` have **no overall request timeout by default**. A dependency that accepts the connection and never replies holds your socket, memory, and the user's request — forever.

Under load, hanging calls accumulate (Little's Law: concurrency = rate × latency; latency → ∞ ⇒ concurrency → ∞) until the process runs out of sockets or memory.

### Kinds of timeouts

| Timeout | Bounds |
|---|---|
| **Connect** | establishing TCP/TLS (should be short: 0.5–2 s) |
| **Read / idle (socket)** | time between bytes |
| **Request / total** | whole request including retries |
| **Pool acquire** | waiting for a DB connection from the pool |
| **Server-side** | `server.requestTimeout`, `headersTimeout`, `keepAliveTimeout` in Node |
| **Query** | `statement_timeout` in PostgreSQL |

### Choosing values
- Base on **measured latency**: a bit above the dependency's p99 (e.g. p99 = 300 ms → timeout 1 s)
- **Timeout budgets / deadlines**: if the user-facing request must finish in 3 s, downstream calls must share that budget. Propagate the remaining deadline downstream (gRPC deadlines, `X-Request-Deadline`)

```text
gateway budget 3 s
  └ order-service: remaining 2.9 s
       ├ inventory call: min(1 s, remaining)
       └ payment call:   min(2 s, remaining)
```

- Outer timeouts must be **longer** than inner ones (+ retries), otherwise the outer layer gives up while inner work continues uselessly

### Node.js

```ts
// per call
const res = await fetch(url, { signal: AbortSignal.timeout(1000) });

// combine user cancellation + timeout
const signal = AbortSignal.any([req.signal ?? new AbortController().signal, AbortSignal.timeout(2000)]);

// server side
server.requestTimeout = 30_000;   // whole request
server.headersTimeout = 10_000;   // slowloris protection
server.keepAliveTimeout = 65_000; // > LB idle timeout to avoid 502 races

// PostgreSQL
const pool = new Pool({ connectionTimeoutMillis: 1000, statement_timeout: 2000 });
```

A timed-out request may **still have succeeded** on the server — the timeout means "I don't know". That's why retries need idempotency (guide 20).

---

## 2. Retries

### When to retry

| Retry ✅ | Don't retry ❌ |
|---|---|
| connection refused/reset, DNS blip | 400, 401, 403, 404, 422 (won't change) |
| timeouts (if idempotent) | business errors ("insufficient funds") |
| 502, 503, 504 | non-idempotent operations without an idempotency key |
| 429 (after `Retry-After`) | when the circuit breaker is open |
| DB deadlock / serialization failure | when the deadline is almost exhausted |

**Idempotent** methods: GET, PUT, DELETE, HEAD (by HTTP spec). POST/PATCH only with an **Idempotency-Key**.

### Exponential backoff

Wait longer between each attempt: `base × 2^attempt`, capped.

```text
attempt 1: 100 ms
attempt 2: 200 ms
attempt 3: 400 ms
attempt 4: 800 ms  (cap at e.g. 5 s)
```

### Jitter — critical

Without jitter, 10,000 clients that failed at the same moment retry at **exactly** the same moments → synchronized waves hammer the recovering service (**thundering herd**).

```text
no jitter:      ████        ████        ████       (spikes)
full jitter:    ▂▃▂▄▃▂▃▄▂▃▂▃▄▂▃▂▄▃▂▃▂▃▄▂▃       (spread)
```

| Variant | Formula |
|---|---|
| Full jitter (recommended) | `sleep = random(0, min(cap, base × 2^n))` |
| Equal jitter | `t = min(cap, base × 2^n); sleep = t/2 + random(0, t/2)` |
| Decorrelated jitter | `sleep = min(cap, random(base, prev × 3))` |

### Implementation

```ts
type RetryOpts = { retries: number; baseMs: number; capMs: number; deadline?: number };

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return [429, 502, 503, 504].includes(err.status);
  if (err instanceof DOMException && err.name === "TimeoutError") return true;
  const code = (err as NodeJS.ErrnoException).code;
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(code ?? "");
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOpts): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= o.retries || !isRetryable(err)) throw err;
      const retryAfter = err instanceof HttpError ? err.retryAfterMs : undefined;
      const delay = retryAfter ?? Math.random() * Math.min(o.capMs, o.baseMs * 2 ** attempt); // full jitter
      if (o.deadline && Date.now() + delay > o.deadline) throw err;  // no budget left
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// usage
const deadline = Date.now() + 3000;
const user = await withRetry(
  () => fetchJson(`http://users/${id}`, { signal: AbortSignal.timeout(800) }),
  { retries: 3, baseMs: 100, capMs: 1000, deadline },
);
```

---

## 3. Retry storms and amplification

Retries multiply load exactly when a system is weakest.

```text
gateway (3 tries) → service A (3 tries) → service B (3 tries) → DB
one user request can become 3 × 3 × 3 = 27 DB calls
```

Defences:

1. **Retry at one layer only** — usually the outermost caller that knows the user's intent, or the layer closest to the failure; not every layer
2. **Retry budget** — cap retries as a % of traffic (e.g. retries ≤ 10% of requests per instance); when exceeded, stop retrying
3. **Circuit breaker** — stop all calls when failure is sustained (guide 18)
4. **Small retry counts** — 2–3 attempts, not 10
5. **Honor `Retry-After`** and 429s
6. **Server-side load shedding** — overloaded servers reject quickly with 503 so retries go elsewhere

```ts
class RetryBudget {
  private requests = 0; private retries = 0;
  constructor(private ratio = 0.1) { setInterval(() => { this.requests = 0; this.retries = 0; }, 10_000).unref(); }
  onRequest() { this.requests++; }
  canRetry() { if (this.retries < Math.max(10, this.requests * this.ratio)) { this.retries++; return true; } return false; }
}
```

---

## 4. Hedged requests (tail-latency trick)

Send the request; if no response after ~p95 latency, send a **second** copy to another replica and use whichever returns first. Cuts p99 dramatically for read-only, idempotent calls at the cost of a few % extra load. (Used by Google BigTable, Cassandra speculative retry.)

---

## 5. Putting it together

```text
request ── deadline 3 s ──▶
  bulkhead (max concurrency)
    └ circuit breaker (fail fast when OPEN)
        └ retry (≤2, full jitter, budget, idempotent only)
            └ timeout per attempt (≈ p99 × 2)
                └ HTTP call with Idempotency-Key
```

---

## 6. Failure modes

| Mistake | Outcome |
|---|---|
| no timeout | resource exhaustion, cascading hangs |
| timeout too short | false failures, retries add load |
| inner timeout > outer timeout | wasted work after caller gave up |
| retries without jitter | synchronized retry spikes |
| retries at every layer | exponential amplification |
| retrying POST without idempotency | duplicate orders/charges |
| retrying 4xx | wasted calls, never succeeds |
| infinite retries in message consumers | poison message loops — cap + DLQ |

---

## 7. Interview questions

1. **Why do we need timeouts?** — Without them, slow dependencies exhaust resources; timeouts bound latency and free resources.
2. **What is exponential backoff with jitter, and why jitter?** — Growing randomized delays; jitter desynchronizes clients to avoid thundering herds.
3. **Which errors are safe to retry?** — Transient network errors, 502/503/504, 429; only for idempotent operations.
4. **What is a retry storm, and how do you prevent it?** — Multiplicative retries under failure; single-layer retries, budgets, circuit breakers.
5. **A request timed out — did it fail?** — Unknown; it may have succeeded. Use idempotency keys to retry safely.
6. **How do you pick timeout values?** — From measured p99 + margin, within an end-to-end deadline budget.
7. **What are hedged requests?** — Duplicate a slow idempotent request to another replica after p95 to cut tail latency.

**Prev:** [18 — Circuit Breaker](18-circuit-breaker.md) · **Next:** [20 — Idempotency](20-idempotency.md)
