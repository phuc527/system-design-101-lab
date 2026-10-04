# 07 — Rate Limiting

> Limit how many requests a client can make in a time window — to protect the system, ensure fairness, and control cost.

---

## 1. The problem

- A buggy client loops and sends 10,000 req/s → your API falls over for everyone
- A scraper downloads your entire catalogue
- Attackers brute-force `/login`
- One big customer consumes all capacity; small customers time out
- An expensive downstream (SMS, LLM API) charges per call

**Rate limiting** caps request rate per identity (user, API key, IP, tenant, endpoint) and rejects the excess with **HTTP 429 Too Many Requests**.

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 12
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: 12
```

---

## 2. Where to limit

```text
client ─▶ CDN/WAF ─▶ API gateway ─▶ service ─▶ downstream
           (IP)      (API key/user)  (business rule)  (client-side limit)
```

| Layer | Good for |
|---|---|
| Edge / WAF | DDoS, per-IP abuse — cheapest place to drop traffic |
| API gateway | per-API-key quotas, plans (free 100/min, pro 10k/min) |
| Service | business limits ("5 password resets/hour") |
| Client side | respect downstream quotas (outbound limiter) |

---

## 3. Algorithms

### 3.1 Fixed window counter

Count requests per window `floor(now / 60s)`.

```text
key = rl:user42:2026-10-04T10:05   INCR → if > 100 reject; EXPIRE 60
```
✅ simplest, O(1) memory
❌ **boundary burst**: 100 requests at 10:05:59 + 100 at 10:06:00 = 200 in 1 second

### 3.2 Sliding window log

Store a timestamp per request (sorted set); count entries in the last 60 s.

```text
ZREMRANGEBYSCORE key 0 (now-60s)
ZCARD key  → if >= limit reject
ZADD key now now
```
✅ exact
❌ memory O(requests) — expensive at high limits

### 3.3 Sliding window counter

Weighted blend of current and previous fixed windows:

```text
estimate = prev_count × (1 - elapsed_fraction) + curr_count
```
e.g. 30% into current window, prev=80, curr=30 → `80×0.7 + 30 = 86`.
✅ O(1) memory, smooths boundary burst, ~accurate (Cloudflare uses this)

### 3.4 Token bucket

Bucket holds up to **capacity** tokens, refilled at **rate** tokens/s. Each request takes a token; empty → reject.

```text
capacity = 10, rate = 1/s
idle 10 s → bucket full → client may burst 10 requests instantly, then 1/s
```
✅ allows controlled **bursts**, smooth average; O(1) state (tokens, last_refill)
Used by AWS API Gateway, Stripe, most gateways.

### 3.5 Leaky bucket

Requests enter a queue that drains at a fixed rate; overflow is rejected.
✅ perfectly smooth **output** rate (protects fragile downstream)
❌ adds queueing latency; bursts not served fast

| Algorithm | Memory | Bursts | Accuracy | Typical use |
|---|---|---|---|---|
| Fixed window | O(1) | 2× at boundary | low | simple quotas |
| Sliding log | O(n) | none | exact | low-volume strict limits |
| Sliding counter | O(1) | smoothed | good | general API limits |
| Token bucket | O(1) | allowed up to capacity | good | APIs with bursty clients |
| Leaky bucket | O(queue) | absorbed, smoothed | good | traffic shaping |

---

## 4. Token bucket implementation

### In-memory (single instance)

```ts
class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(private capacity: number, private refillPerSec: number) {
    this.tokens = capacity;
  }

  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
```

### Distributed (Redis + Lua, atomic)

With 3 API instances, in-memory limiters each allow the full limit → effective limit 3×. Shared state in Redis fixes that.

```lua
-- KEYS[1]=bucket  ARGV: capacity, refill_per_sec, now_ms
local cap   = tonumber(ARGV[1])
local rate  = tonumber(ARGV[2])
local now   = tonumber(ARGV[3])
local b     = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or cap
local ts     = tonumber(b[2]) or now
tokens = math.min(cap, tokens + (now - ts) / 1000 * rate)
local allowed = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate * 1000) + 1000)
return { allowed, math.floor(tokens) }
```

```ts
const script = fs.readFileSync("token-bucket.lua", "utf8");

export function rateLimit(capacity: number, perSec: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const id = req.header("x-api-key") ?? req.ip;
    try {
      const [allowed, remaining] = (await redis.eval(script, 1, `rl:${id}`, capacity, perSec, Date.now())) as [number, number];
      res.setHeader("RateLimit-Remaining", remaining);
      if (!allowed) { res.setHeader("Retry-After", Math.ceil(1 / perSec)); return res.status(429).json({ error: "rate_limited" }); }
      next();
    } catch {
      next(); // Redis down → fail open (decide deliberately!)
    }
  };
}
```

Why Lua? Read-compute-write must be **atomic**; otherwise two instances read the same token count and both allow.

(Use Redis server time or tolerate small clock skew between app instances.)

---

## 5. Design decisions

- **Identity:** API key > user ID > IP. IPs are shared (NAT, mobile carriers) and spoofable via `X-Forwarded-For` if you trust it blindly.
- **Granularity:** global, per endpoint (`POST /login` stricter), per tenant, per plan.
- **Fail open or closed when the limiter store is down?** Open keeps the product up (most APIs). Closed for security-critical limits (login brute force).
- **Hard vs soft limits:** reject vs log/alert/throttle.
- **Cost-based limits:** expensive endpoints cost more tokens.
- **Local + global hybrid:** each instance keeps a local bucket and syncs to Redis periodically — fewer Redis calls, slightly less accurate.

---

## 6. Related: load shedding and backpressure

Rate limiting is **per client**. **Load shedding** is **global**: when the server itself is overloaded (CPU, event-loop lag, queue depth), reject low-priority work regardless of who sent it.

```ts
import { monitorEventLoopDelay } from "node:perf_hooks";
const h = monitorEventLoopDelay(); h.enable();
app.use((req, res, next) => (h.mean / 1e6 > 200 ? res.status(503).end() : next()));
```

---

## 7. Failure modes

| Problem | Effect | Fix |
|---|---|---|
| per-instance limiter behind LB | limit × N | shared Redis store |
| non-atomic check-then-set | over-admission under concurrency | Lua / `INCR` |
| limiter store slow | adds latency to every request | timeouts, local fallback |
| trusting `X-Forwarded-For` | attacker rotates fake IPs | trust only your proxy's header (`app.set("trust proxy", 1)`) |
| clients retry 429 immediately | retry storm | `Retry-After`, clients use backoff |
| hot key in Redis | one shard overloaded | local pre-limiting |

---

## 8. Production checklist

- [ ] Limits at edge (IP) and gateway (key/user)
- [ ] Stricter limits on auth and expensive endpoints
- [ ] 429 + `Retry-After` + `RateLimit-*` headers
- [ ] Distributed, atomic counter
- [ ] Deliberate fail-open/closed decision
- [ ] Metrics: allowed vs rejected per key/route
- [ ] Documented limits for API consumers

---

## 9. Interview questions

1. **Compare token bucket and leaky bucket.** — Token bucket permits bursts up to capacity; leaky bucket smooths output at a constant rate.
2. **Fixed window problem?** — 2× burst at window boundaries; use sliding window.
3. **How do you rate limit across 10 servers?** — Shared store (Redis) with atomic Lua/INCR; or local+sync hybrid.
4. **What status code and headers?** — 429, `Retry-After`, `RateLimit-*`.
5. **Redis is down — what does the limiter do?** — Decide: fail open for availability, fail closed for security limits.
6. **Rate limiting vs load shedding?** — Per-client fairness vs protecting the server under global overload.
7. **Design a rate limiter for 1M API keys.** — Token bucket in Redis cluster keyed by API key, Lua for atomicity, TTL on idle buckets, gateway enforcement, local cache for hot keys.

**Prev:** [06 — Database Sharding](06-database-sharding.md) · **Next:** [08 — Message Queue](08-message-queue.md)
