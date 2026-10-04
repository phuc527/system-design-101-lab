# 18 — Circuit Breaker

> When a dependency is failing, calling it harder makes everything worse. A circuit breaker stops calling it for a while, fails fast, and checks back later.

---

## 1. The problem — cascading failure

```text
client → order-service → payment-service (slow: 30 s timeouts)
```

1. payment-service gets slow
2. order-service requests pile up waiting (threads/sockets/memory held, event loop busy with retries)
3. order-service runs out of connections → becomes slow itself
4. API gateway waits on order-service → gateway slow
5. **one slow leaf takes down the whole system**

And retries from every caller add *more* load to the struggling payment-service, preventing its recovery.

---

## 2. The idea

Borrowed from electrical circuit breakers: if too much fails, **trip** and stop the flow.

```text
            failures ≥ threshold
   ┌────────┐ ─────────────────▶ ┌────────┐
   │ CLOSED │                    │  OPEN  │  ← calls fail immediately (no network call)
   └────────┘ ◀──┐               └────────┘
       ▲         │ trial ok          │ after reset timeout
       │         │                   ▼
       │      ┌───────────┐ ◀────────┘
       └──────│ HALF_OPEN │  ← let a few trial calls through
              └───────────┘ ── trial fails ──▶ OPEN
```

| State | Behaviour |
|---|---|
| **CLOSED** | normal; calls go through; failures counted |
| **OPEN** | calls rejected instantly (`CircuitOpenError`) → fallback; no load on dependency |
| **HALF_OPEN** | after cooldown, allow N trial calls. Success → CLOSED; failure → OPEN again |

Benefits:
- **fail fast** — caller returns in 1 ms instead of waiting 30 s
- **protects caller resources** (sockets, memory, event loop)
- **gives the dependency room to recover**
- **enables fallbacks / graceful degradation**

---

## 3. Trip conditions

| Strategy | Example |
|---|---|
| Consecutive failures | 5 failures in a row |
| Failure **rate** over sliding window | ≥ 50% of the last 20 calls (with a minimum volume, e.g. ≥ 10 calls) |
| **Slow call** rate | ≥ 50% of calls took > 2 s (slow is the new down) |
| Time-based window | last 10 s |

**Minimum request volume** matters: 1 failure out of 1 call = 100% → don't trip on tiny samples.

What counts as failure? Timeouts, connection errors, 5xx, 429. **Not** 4xx like 400/404 — those are the caller's fault and say nothing about dependency health.

---

## 4. Node.js implementation

```ts
type State = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitOpenError extends Error {
  constructor(name: string) { super(`circuit ${name} is open`); }
}

export class CircuitBreaker {
  private state: State = "CLOSED";
  private window: boolean[] = [];          // true = failure
  private openedAt = 0;
  private halfOpenInFlight = 0;

  constructor(
    private name: string,
    private opts = { windowSize: 20, minCalls: 10, failureRate: 0.5, resetTimeoutMs: 10_000, halfOpenMax: 3, timeoutMs: 2_000 },
  ) {}

  async call<T>(fn: (signal: AbortSignal) => Promise<T>, fallback?: () => T | Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (Date.now() - this.openedAt >= this.opts.resetTimeoutMs) this.transition("HALF_OPEN");
      else return this.reject(fallback);
    }
    if (this.state === "HALF_OPEN" && this.halfOpenInFlight >= this.opts.halfOpenMax) return this.reject(fallback);

    const trial = this.state === "HALF_OPEN";
    if (trial) this.halfOpenInFlight++;
    try {
      const result = await fn(AbortSignal.timeout(this.opts.timeoutMs));
      this.onResult(false);
      return result;
    } catch (err) {
      this.onResult(true);
      if (fallback) return fallback();
      throw err;
    } finally {
      if (trial) this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    }
  }

  private onResult(failed: boolean) {
    if (this.state === "HALF_OPEN") {
      this.transition(failed ? "OPEN" : "CLOSED");
      return;
    }
    this.window.push(failed);
    if (this.window.length > this.opts.windowSize) this.window.shift();
    const failures = this.window.filter(Boolean).length;
    if (this.window.length >= this.opts.minCalls && failures / this.window.length >= this.opts.failureRate) {
      this.transition("OPEN");
    }
  }

  private transition(to: State) {
    if (to === this.state) return;
    logger.warn({ breaker: this.name, from: this.state, to }, "circuit state change");
    this.state = to;
    if (to === "OPEN") this.openedAt = Date.now();
    if (to === "CLOSED") this.window = [];
  }

  private async reject<T>(fallback?: () => T | Promise<T>): Promise<T> {
    if (fallback) return fallback();
    throw new CircuitOpenError(this.name);
  }
}
```

Usage:

```ts
const paymentsBreaker = new CircuitBreaker("payments");

app.get("/recommendations", async (req, res) => {
  const recs = await recsBreaker.call(
    (signal) => fetch("http://recs/api", { signal }).then((r) => { if (r.status >= 500) throw new Error(String(r.status)); return r.json(); }),
    () => cache.get("popular-products") ?? [],   // fallback
  );
  res.json(recs);
});

app.use((err, _req, res, _next) => {
  if (err instanceof CircuitOpenError) return res.status(503).set("Retry-After", "10").json({ error: "dependency_unavailable" });
  // ...
});
```

Library: **opossum** is the standard Node circuit breaker (events, metrics, fallbacks). Resilience4j (Java), Polly (.NET), Envoy/Istio outlier detection (infrastructure level).

---

## 5. Fallback strategies

| Fallback | Example |
|---|---|
| Cached / stale data | last known product price, popular items |
| Default value | empty recommendations, "shipping estimate unavailable" |
| Degraded feature | hide the reviews widget |
| Alternative provider | secondary payment gateway |
| Queue for later | accept order, charge asynchronously |
| Fail fast with clear error | 503 + `Retry-After` |

Not everything can fall back — a payment can't "pretend" to succeed. Decide per dependency: **critical** (fail the request) vs **optional** (degrade).

---

## 6. Related patterns

### Bulkhead
Isolate resources per dependency so one can't exhaust all of them (like watertight compartments in a ship).

```ts
import pLimit from "p-limit";
const paymentsPool = pLimit(20);   // at most 20 concurrent calls to payments
const recsPool = pLimit(10);
await paymentsPool(() => paymentsBreaker.call(charge));
```
Separate HTTP agents/connection pools per upstream achieve the same.

### Timeouts (guide 19)
A breaker without timeouts never sees failures — the calls just hang. Timeouts first, breaker on top.

### Retries (guide 19)
Order: **retry inside breaker** (each attempt counted) or breaker inside retry (retry stops when circuit opens). Never retry `CircuitOpenError` immediately.

```text
request → bulkhead → circuit breaker → retry (with backoff) → timeout → HTTP call
```

---

## 7. Operational concerns

- **Per dependency** (and sometimes per endpoint/host) — one breaker for "all external calls" would trip everything for one bad host
- **Per instance state** — each app instance has its own breaker; that's usually fine (each detects independently). Shared state in Redis is rarely worth it
- **Observability** — emit state changes as metrics/logs; alert on OPEN; dashboards of failure rate
- **Tuning** — too sensitive → flapping and unnecessary outages; too lax → doesn't protect. Start with ~50% over 20 calls, 10–30 s reset
- **Test it** — chaos experiments: inject latency/errors into dependency, watch it trip and recover

---

## 8. Trade-offs

| Gain | Cost |
|---|---|
| prevents cascading failure, fail fast | some requests rejected that might have succeeded |
| dependency gets recovery time | tuning thresholds is empirical |
| enables graceful degradation | fallbacks must be designed and tested |
| | more states to reason about and observe |

---

## 9. Interview questions

1. **What problem does a circuit breaker solve?** — Cascading failures and resource exhaustion from calling a failing dependency.
2. **Explain the three states.** — CLOSED normal; OPEN fail fast; HALF_OPEN trial calls decide.
3. **Which errors should count as failures?** — Timeouts, connection errors, 5xx/429 — not client 4xx.
4. **Circuit breaker vs retry?** — Retry handles transient blips; breaker stops calling when failure is sustained. Use together.
5. **What is a bulkhead?** — Resource isolation per dependency so one can't exhaust shared pools.
6. **What do you return when the circuit is open?** — Fallback (cache/default/degraded) or 503 with Retry-After.

**Prev:** [17 — Health Check](17-health-check.md) · **Next:** [19 — Retry & Timeout](19-retry-timeout.md)
