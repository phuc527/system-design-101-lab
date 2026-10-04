# 02 — Caching

> "There are only two hard things in Computer Science: cache invalidation and naming things." — Phil Karlton

---

## 1. The problem

A product page query takes 80 ms in PostgreSQL. It's requested 5,000 times/s and the data changes once an hour. You're doing the same expensive work 18 million times for the same answer.

A **cache** stores the result of expensive work in faster storage so repeat requests skip the work.

```text
without cache:  client → API → DB (80 ms)
with cache:     client → API → cache (0.5 ms)  → DB only on miss
```

Benefits: lower latency, higher throughput, less load (and cost) on the source of truth, survives brief DB outages.

---

## 2. Where caches live

```text
Browser ─▶ CDN ─▶ LB / reverse proxy ─▶ API (in-process) ─▶ distributed cache (Redis) ─▶ DB (buffer pool)
```

| Layer | Example | Scope | Latency |
|---|---|---|---|
| Client | browser HTTP cache, mobile storage | one user | 0 ms |
| Edge | CDN (Cloudflare, CloudFront) | region | ~10 ms |
| Reverse proxy | Nginx `proxy_cache`, Varnish | all users | ~1 ms |
| In-process | `Map`, `lru-cache` | one instance | ~µs |
| Distributed | Redis, Memcached | all instances | ~0.5 ms |
| Database | PG shared buffers, MySQL buffer pool | DB | automatic |

**In-process vs distributed:** in-process is fastest but each instance has its own copy (inconsistent, wasted memory, cold on restart). Distributed is shared and survives app restarts but costs a network hop. Many systems use **both** (L1 in-process with short TTL, L2 Redis).

---

## 3. Caching patterns

### Cache-aside (lazy loading) — the default

```text
read:  1. GET cache  → hit? return
       2. miss → query DB
       3. SET cache (with TTL) → return
write: 1. UPDATE DB
       2. DELETE cache key   (not update!)
```

```ts
async function getProduct(id: string): Promise<Product> {
  const key = `product:${id}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  const product = await db.product.findById(id);
  await redis.set(key, JSON.stringify(product), "EX", 300);
  return product;
}

async function updateProduct(id: string, data: Partial<Product>) {
  await db.product.update(id, data);
  await redis.del(`product:${id}`);
}
```

✅ only caches what's actually read; cache failure → still works (slower)
❌ first read is always a miss; window of staleness

**Why delete instead of update on write?** Two concurrent writers can update the cache in the opposite order from the DB, leaving the cache permanently wrong. Deleting forces the next read to fetch the truth.

### Read-through
Like cache-aside, but the **cache library** loads from DB on miss. App only talks to the cache.

### Write-through
Every write goes to cache **and** DB synchronously.
✅ cache always fresh  ❌ write latency higher; caches data nobody reads

### Write-behind (write-back)
Write to cache, return immediately, flush to DB asynchronously in batches.
✅ very fast writes, batched DB load  ❌ **data loss** if cache dies before flush; complex

### Refresh-ahead
Proactively refresh hot keys before they expire.
✅ no miss latency for hot keys  ❌ wasted work if prediction wrong

| Pattern | Read latency | Write latency | Consistency | Risk |
|---|---|---|---|---|
| Cache-aside | miss penalty | DB only | stale window | low |
| Read-through | miss penalty | DB only | stale window | low |
| Write-through | fast | slower | good | cache bloat |
| Write-behind | fast | fastest | eventual | data loss |
| Refresh-ahead | fastest | — | good for hot keys | wasted refreshes |

---

## 4. Expiration and eviction

**Expiration (TTL)** — the key dies after N seconds. Bounds staleness. Shorter TTL = fresher data but lower hit rate.

**Eviction** — cache is full, something must go:

| Policy | Evicts | Good for |
|---|---|---|
| LRU | least recently used | general purpose (most common) |
| LFU | least frequently used | stable popularity (hot items stay) |
| FIFO | oldest inserted | simple, rarely ideal |
| Random | random key | cheap, surprisingly OK |
| TTL-based | soonest to expire | Redis `volatile-ttl` |

Redis: `maxmemory 2gb` + `maxmemory-policy allkeys-lru`.

---

## 5. Cache invalidation strategies

1. **TTL only** — simplest; accept staleness up to TTL.
2. **Delete on write** — cache-aside; staleness window ≈ ms.
3. **Event-driven** — DB change → event (CDC/Kafka) → delete keys in all caches.
4. **Versioned keys** — `product:42:v7`; bump version on write; old keys expire naturally.

### The classic race in cache-aside

```text
T1 (reader): miss → read DB (old value) ....................→ SET cache(old)  ✗ stale forever(until TTL)
T2 (writer):               UPDATE DB → DEL cache
```

Mitigations: always use TTL as a safety net; **delayed double delete** (delete, then delete again after ~500 ms); or versioning.

---

## 6. Cache stampede (thundering herd / dog-piling)

A hot key expires. 10,000 concurrent requests miss at once and all hit the DB.

```text
t=0  key expires
t=1  10,000 requests → miss → 10,000 DB queries → DB dies
```

**Fixes:**

1. **Request coalescing / single-flight** — only one request recomputes; others wait for its result.
2. **Lock** — `SET lock:key 1 NX EX 5`; winner recomputes, losers wait/retry or serve stale.
3. **Stale-while-revalidate** — serve the expired value while one worker refreshes.
4. **Probabilistic early expiration (XFetch)** — each request has a growing chance to refresh before TTL.
5. **TTL jitter** — `ttl = 300 + random(0..60)` so keys don't expire together.

```ts
const inflight = new Map<string, Promise<unknown>>();

async function singleFlight<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = load().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
```

(Single-flight in-process protects per instance; across instances use a Redis lock.)

---

## 7. Other failure modes

| Problem | What happens | Fix |
|---|---|---|
| **Cache penetration** | requests for keys that don't exist (e.g. `id=-1`) always miss and hit DB | cache negative results (`null` with short TTL); Bloom filter |
| **Cache avalanche** | many keys expire together or cache cluster dies → DB flood | TTL jitter, HA cache, rate-limit DB, circuit breaker |
| **Hot key** | one key gets 100k RPS, one Redis shard melts | local L1 cache, key replication (`key#1..#N`) |
| **Big key** | 10 MB value blocks Redis, saturates network | split, compress, paginate |
| **Stale data** | users see old price | shorter TTL, delete-on-write, events |
| **Cold start** | after deploy/restart, hit rate 0% | warm-up job, gradual rollout |

---

## 8. What (not) to cache

✅ Good: read-heavy, expensive to compute, tolerates staleness — product catalogue, user profiles, rendered pages, config, aggregates.
❌ Bad: rarely re-read data, highly personalized one-shot data, data where staleness is dangerous (account balance during transfer), huge objects.

**Measure hit ratio:** `hits / (hits + misses)`. Below ~80% for a read cache → question your TTL, keys or whether caching helps at all.

---

## 9. HTTP caching (free caching)

```http
Cache-Control: public, max-age=60, stale-while-revalidate=30
ETag: "a1b2c3"
```

- `max-age` — fresh for N seconds
- `private` — browser only, not CDN
- `no-store` — never cache
- `ETag` + `If-None-Match` → `304 Not Modified` (saves bandwidth, not round trip)

---

## 10. Trade-offs

- **Freshness vs hit rate** (TTL length)
- **Speed vs consistency** — every cache is a second copy that can disagree
- **Memory cost vs DB cost**
- **Complexity** — invalidation bugs are subtle and hard to reproduce

---

## 11. Production checklist

- [ ] Every key has a TTL (safety net)
- [ ] TTL jitter on bulk-loaded keys
- [ ] Stampede protection on hot keys
- [ ] Negative caching for misses
- [ ] Cache down ⇒ app still works (timeouts + fallback to DB with protection)
- [ ] Hit ratio, latency, memory, evictions monitored
- [ ] Key naming convention: `service:entity:id[:version]`
- [ ] Serialization versioned (schema change won't crash old readers)

---

## 12. Interview questions

1. **Cache-aside vs write-through?** — Cache-aside loads on read and deletes on write; write-through writes both synchronously, always fresh but slower writes.
2. **Why delete instead of update cache on write?** — Avoids out-of-order concurrent writes leaving wrong data.
3. **What is a cache stampede and how do you prevent it?** — Mass miss on a hot key; single-flight/lock, stale-while-revalidate, jitter.
4. **Penetration vs avalanche vs stampede?** — Non-existent keys / many keys at once / one hot key.
5. **LRU vs LFU?** — Recency vs frequency; LFU keeps steadily popular items through bursts.
6. **How do you keep caches consistent across services?** — TTL + invalidation events (CDC) + versioned keys; accept eventual consistency.
7. **When is caching a bad idea?** — Low re-read rate, strict consistency needs, or when it hides a missing index.

**Prev:** [01 — Load Balancer](01-load-balancer.md) · **Next:** [03 — Redis](03-redis.md)
